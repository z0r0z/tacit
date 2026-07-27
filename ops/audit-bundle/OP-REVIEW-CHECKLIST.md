# Op review checklist

One line per op — the invariant an auditor should personally confirm. Grouped by settle-guest op (Ethereum
dispatch, `main.rs`) and reflection fold (Bitcoin lane, `reflect.rs` / `cxfer-core`). For every op the
four recurring questions are: **authorization** (only the rightful holder acts), **value conservation** (per
asset, nothing created/destroyed), **destination binding** (outputs/recipients cannot be redirected), and, for
reflection, **skip-vs-abort** (malformed tx content skips the fold, never halts the guest; membership witnesses
fail closed). The one-liners below name the op-specific thing to check on top of these.

## Settle-guest ops (`main.rs` dispatch)

| op | # | invariant to confirm |
|---|---:|---|
| `OP_WRAP` | 0 | minted note value == the exact pending public deposit; escrow credited before mint |
| `OP_TRANSFER` | 1 | kernel conserves per asset; recipient + change destinations bound; input nullified once |
| `OP_UNWRAP` | 2 | payout ≤ note value; opening-sigma binds recipient+payout+fee+deadline (no relay redirect); escrow debited fail-closed |
| `OP_BRIDGE_BURN` | 3 | emits a crossOut keyed to the exact spent source; note nullified; no leaf appended (minted on Bitcoin) |
| `OP_BRIDGE_MINT` | 4 | one mint per `burn_id`; membership of burned leaf in attested pool root + `burn_id→dest` in burn set; value verbatim |
| `OP_COVENANT_MINT` | 5 | reserved — no handler; op 5 must be rejected as unknown |
| `OP_SWAP` | 6 | clears against public reserves; k non-decreasing; fee floor exact; output minted to bound out_owner |
| `OP_LP_ADD` | 7 | in-ratio add; minted share note value matches contributed reserves; min-share respected |
| `OP_LP_REMOVE` | 8 | burns share note, withdraws underlying pro-rata; cannot remove the locked MINIMUM_LIQUIDITY |
| `OP_OTC` | 9 | 2-party swap conserves both legs; both parties' authorizations bound; no pool touched |
| `OP_BID` | 10 | partial-fill grid amount within the pre-authorized bid; seller cannot overfill; buyer sig binds terms |
| `OP_SWAP_ROUTE` | 11 | ≤ MAX_ROUTE_HOPS; each hop clears against its pool; value chains hop-to-hop; final output bound |
| `OP_ADAPTOR_LOCK` | 12 | per-input opening PoK (own blinding, not just excess); lock leaf under (T, deadline, recipient) |
| `OP_ADAPTOR_CLAIM` | 13 | claim before deadline reveals kernel s; claim_sig binds claimer + vout-0 destination |
| `OP_ADAPTOR_REFUND` | 14 | refund only after deadline, only to the locker; deadline-exclusive with claim |
| `OP_CDP_MINT` | 15 | controller authorizes debt amount; collateral basket locked ≥ ratio; debt note minted exact |
| `OP_CDP_CLOSE` | 16 | burns the exact debt → reclaims basket; no oracle/veto path skips the burn |
| `OP_CDP_LIQUIDATE` | 17 | controller proves unhealthy; exact debt burned before basket seized; no equity theft on close |
| `OP_CBTC_MINT` | 18 | mints against a reflection-recorded self-custody lock; contract gates lock + escrow |
| `OP_CDP_TOPUP` | 19 | old position consumed + replacement appended with larger basket; stays liquidatable (no bad-debt) |
| `OP_FARM_BOND` | 20 | LP-share notes locked → receipt note; controller stamps `entryRps` at settle on a stable receipt leaf |
| `OP_FARM_HARVEST` | 21 | reward bounded by stamped entry; re-stamp in place (replay pays 0); owner_sig required |
| `OP_FARM_UNBOND` | 22 | receipt nullified; LP-share notes re-minted exact; stamped debt retired; owner_sig required |
| `OP_STEALTH_LOCK` | 23 | per-input opening PoK before lock; lock under recipient one-time pubkey in shared lock-set |
| `OP_STEALTH_CLAIM` | 24 | BIP-340 sig under the one-time pubkey; value to claimer; lock consumed once |
| `OP_STEALTH_REFUND` | 25 | locker reclaims only after deadline; kernel-gated; deadline-exclusive with claim |
| `OP_BRIDGE_STEALTH_MINT` | 26 | Bitcoin burn → shared lock-set under recipient one-time pubkey; one mint per burn_id; claimed via op 24 |
| `OP_WRAP_TRANSFER` | 27 | fused wrap+transfer: consumes exact pending deposit, emits hidden recipient(+change); conservation of both |
| `OP_SEND_AND_UNWRAP` | 28 | one hidden input → public payout + hidden change; only payout public; opening-sigma anti-redirect; fee=0 self-settle |
| `OP_LP_BOND` | 29 | fused add+bond: share note never materializes; shares → receipt leaf + bond; both authorizations bound |
| `OP_WRAP_CDP_MINT` | 30 | fused wrap+cdp_mint from public deposit basket; debt-mint/position identical to op 15 |
| `OP_SWAP_BLIND` | 31 | **dormant** (no emitter): in-guest BN254 Groth16 + aggregate Pedersen identity + per-receipt cross-curve; per-asset tips asserted fail-closed to 0; audit for soundness |
| `OP_WRAP_LP` | 32 | fused wrap+lp_add from two public deposits; deposit value exact+public (bound in deposit_id); no intermediate note |
| `OP_WRAP_SWAP` | 33 | fused wrap+swap from a public deposit; same deposit-exactness argument as op 32 |

## Reflection folds (`reflect.rs` / `cxfer-core`)

Every fold below must: skip (not abort) on tx-controlled malformation; prove membership/non-membership verdicts
fail-closed; and, where it onboards a note, bind the output authority verbatim from the confirmed tx and reject a
zero (non-P2TR) auth key.

| fold | invariant to confirm |
|---|---|
| `fold_spent` | every consumed input nullified exactly once; leaf reconstructed with full authenticated fields |
| `fold_consumed` | fast-lane-retired outpoints folded into the consumed-outpoints IMT (double-mint gate source) |
| `fold_output` | new UTXO → commitment recorded; outpoint keyed to the real confirmed vout |
| `fold_cxfer` | conservation per asset; receipt/change destinations SIGHASH_ALL-bound; skip on malformed |
| `fold_swap_var` | clears at current price with refund floor; sentinel (no-change) skips the change range check + SPK bind; intent_sig verified; expiry≠0 |
| `fold_swap_route` | per-hop current-price clearing; in-reserve overflow + direction guards; intent_sig verified |
| `fold_swap_batch` | per-intent intent_sig binds spend+cross-curve+dests+min_out+tip+expiry; execute-vs-refund branch conserves; skip whole batch on bad sig |
| `fold_lp_add` / `fold_lp_remove` | pay from current pool state, not declared values; destinations bound; share accounting exact |
| `fold_protocol_fee_claim` | crystallizes a publicly-recomputable fee; NOT provenance-eligible; binds claim + vout-0 dest |
| `fold_farm_init` | `farm_init_msg` (farm_id ⇒ pool/launcher/asset/nonce + terms) BIP-340-verified; funding kernel conserves |
| `fold_farm_init_rewards` | reward schedule bound to the authorized farm_id |
| `fold_harvest` / `fold_lp_harvest` | reward bounded by stamped entry; owner_sig; replay pays 0 |
| `fold_farm_refund` | envelope launcher_pubkey matched to the one committed in farm_id + stored launcher; launcher_sig |
| `fold_lp_bond` | `lp_bond_msg` binds farm/bonder/amount/entry/view-height AND receipt owner_commit+nonce; bonder_sig |
| `fold_lp_unbond` | stamped debt retired exactly; LP shares re-minted; stamp deleted |
| `fold_lp_share_mint` | minted share value bound to the proven contribution |
| `fold_burn` | keys the burn accumulator by source-specific `burn_id`; one burn record per authenticated source |
| `fold_crossout` | gates on ETH-set membership (Mode-B finalized state); mints Bitcoin note to the burner-named key; no replay |
| `fold_cbtc_lock` / `fold_cbtc_lock_spends` | admits a backed mint, rejects tampering; records the self-custody lock |
| `fold_cbtc_redeem` | classifies honest exit vs spoof; unauthorized spend → slash path |
| `fold_btc_call` | caller_pubkey signs the domain-tagged call binding incl. authorized executor |
| burn-deposit onboarding (`burn_deposit.rs`) | provenance DAG admits only the CXFER/AXFER allowlist; consumed-outpoint non-membership proven fail-closed (member→skip, non-member→fold, lying witness→abort) |
