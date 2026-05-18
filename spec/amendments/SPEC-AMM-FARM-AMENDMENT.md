# SPEC AMM Amendment — LP-Bond Yield Farms (`T_FARM_INIT` / `T_LP_BOND` / `T_LP_UNBOND`)

> **Status: 📝 Draft (round-1, post-sanity-check revision).** Adds
> MasterChef-style staked-LP rewards to the tacit AMM via three new
> opcodes — `T_FARM_INIT` (`0x34`), `T_LP_BOND` (`0x35`),
> `T_LP_UNBOND` (`0x36`). Permissionless launcher-funded reward
> treasuries, lazy per-block accrual mirroring the existing
> protocol-fee `mintFee` pattern, virtual-bookkeeping treasury
> custody (no on-chain treasury UTXOs), per-bond worker-indexed
> records. Reuses the kernel-sig + Pedersen + bulletproof stack from
> `T_SWAP_VAR` / `T_AXFER_VAR`. **No Groth16, no new ceremony, no
> coupling to the AMM Phase-2 ceremony.**
>
> **Round-1 sanity-check pass (2026-05-18) corrected:**
> - Treasury custody switched from NUMS-sentinel UTXOs to virtual
>   bookkeeping. NUMS-sentinel outputs are permanently unspendable
>   in tacit (`AMM.md`:770 MINIMUM_LIQUIDITY precedent); the
>   protocol-owned-balance idiom is virtual indexer state (AMM
>   reserves, mixer pool, cBTC.tac insurance reserve all use this).
> - Removed `lp_input_r` / `launcher_input_r` openings (would have
>   leaked pre-tx wallet balance). Adopted the `T_SWAP_VAR` pattern:
>   input commitments not opened; closed via kernel sig on the
>   excess scalar + range proof on change.
> - Bond receipts demoted from "fungible tacit asset class" to plain
>   P2WPKH dust markers for wallet discovery. Per-outpoint
>   `entry_acc` snapshots are inherently non-fungible — pretending
>   otherwise added validator complexity (`T_CXFER` pubkey rotation)
>   without delivering real receipt-transferability.
> - Dropped both `kernel_sig_lp` and `kernel_sig_reward` on
>   `T_LP_UNBOND` — with virtual treasury and all output openings
>   public, only the BIP-340 envelope sig is load-bearing.
> - Bulletproof scope reduced: `T_FARM_INIT` and `T_LP_BOND` need
>   m=1 (on change only); `T_LP_UNBOND` needs none.
>
> Depends on:
> - `AMM.md` (defines `lp_asset_id`, virtual-pool architecture,
>   depth-3 confirmation gate, lazy `mintFee` accrual)
> - `SPEC.md` §5.20 `T_SWAP_VAR` (kernel-sig + Pedersen opening
>   pattern reused verbatim)
> - `SPEC-CBTC-TAC-AMENDMENT.md` (canonical TAC asset_id; cBTC.tac /
>   TAC pool semantics referenced by the bootstrap section)

---

## Motivation

The tacit AMM ships LP-share fee compounding (Uniswap V2 model — LP
fees roll into reserves, LPs dilute on remove) and an optional
founder-pinned protocol-fee skim (`T_PROTOCOL_FEE_CLAIM` `0x31`,
`AMM.md` §"Accrual model: Uniswap V2 lazy mintFee"). Both reward
*existing* depth proportionally. Neither bootstraps depth from zero.

Early LPs in a new pool — particularly the canonical `cBTC.tac / TAC`
and `cBTC.tac / cBTC.zk` pairs — face concentrated impermanent-loss
exposure at low total depth while the pool's price discovery
converges. Without an explicit incentive, the first-mover penalty
keeps depth thin, swap latency high, and trader UX poor. Every
production AMM ecosystem (Uniswap V2 + SushiSwap, Curve + CRV,
Balancer + BAL, etc.) solved this with a staked-LP rewards layer:
LPs lock their LP tokens into a "farm" contract that streams a
secondary reward token at a fixed per-block rate, compensating IL
exposure during the bootstrap window.

The tacit-native version has four constraints the EVM versions don't:

1. **LP positions are UTXO notes, not balances.** Per-user `(amount,
   rewardDebt)` state in canonical pool storage breaks the model.
2. **No party custodies protocol-owned balances.** Tacit's virtual-
   pool architecture (`AMM.md`:1845) eliminates pool UTXOs entirely;
   reserves are indexer-attested virtual quantities. The farm
   treasury follows the same pattern.
3. **Depth-3 finality gate.** Bond/unbond reads pin against
   canonical pool state, not pending tip.
4. **Privacy properties.** Bond amounts that are confidential break
   `acc_reward_per_share` math; transparent bond amounts that are
   *aggregated* preserve privacy adequately when paired with mixer
   flow upstream of the bond.

`T_FARM_INIT` / `T_LP_BOND` / `T_LP_UNBOND` resolve all four:

- The farm treasury is a virtual `treasury_remaining` field in
  canonical farm state — never an on-chain UTXO. `T_FARM_INIT`
  consumes the launcher's reward-asset UTXO via kernel-sig closure;
  `T_LP_UNBOND` mints a fresh reward UTXO by validator decree. Same
  conservation model as every other tacit protocol-owned balance.
- Per-bond state lives in a worker-indexed bond record keyed by the
  bond tx's wallet-discovery outpoint. Receipts are NOT a tacit
  asset class; they're plain P2WPKH dust markers.
- Accrual crystallizes lazily on every farm-mutating event using
  the same arithmetic shape as `mintFee` (`AMM.md` §3352).
- All reads pin at depth ≥ 3, identical discipline to `T_LP_ADD` /
  `T_LP_REMOVE`.
- Bond amounts are cleartext (required for `total_bonded`
  accounting); bonders preserve wallet privacy by routing LP shares
  through the mixer upstream of `T_LP_BOND` (`AMM.md` §"LP shares as
  a confidential tacit asset").

The result is a small additive surface — three opcodes, no Groth16,
no ceremony — that materially de-risks pool bootstrap.

---

## §5.40 `T_FARM_INIT` (`0x34`) — launcher-funded reward farm creation

> Section numbers `§5.40` / `§5.41` / `§5.42` reflect the draft
> target in `SPEC.md`. Final numbers are pinned at merge.

### Pre-conditions

- Target pool exists (`pool_id` resolves to depth-3-confirmed pool state).
- `start_height ≥ current_height + 3` (validator pins against the
  publishing tx's confirmation height; the `+3` matches the AMM
  depth-3 gate so the farm activates only after canonical pool state
  has stabilised).
- `start_height ≥ pool.init_height + AMM_INITIAL_LP_LOCK_BLOCKS` (no
  farms over a pool still inside its first-LP lock window).
- `reward_per_block ≥ 1`.
- `reward_total ≥ AMM_FARM_MIN_REWARD_TOTAL` (anti-spam dust floor).
- `reward_total ≡ 0 (mod reward_per_block)` (no fractional final
  block; keeps accrual math integer-exact).
- `end_height = start_height + reward_total / reward_per_block`
  (validator recomputes and rejects on mismatch).

### Wire format

```
T_FARM_INIT envelope payload (consumed by indexer; OP_RETURN at
vout[0] carries SHA256(payload) as envelope_hash):

envelope_version           1 B  = 0x01
opcode                     1 B  = 0x34
pool_id                   32 B  (= SHA256("tacit-amm-pool-v1" || asset_A || asset_B
                                  || fee_bps || protocol_fee_config || capability_flags),
                                  see AMM.md §"Pool state")
farm_nonce                32 B  launcher-supplied randomness; participates in farm_id
                                  derivation. Allows the same launcher to fund multiple
                                  concurrent farms against the same pool.
launcher_pubkey           33 B  compressed secp256k1. Funder of the treasury and
                                  attribution recipient for the farm record. NOT a
                                  privileged operator post-init — see "Permissionlessness
                                  post-init" below.
reward_asset_id           32 B  Tacit asset_id of the emission token. Canonical farms
                                  use TAC (env-pinned per network); arbitrary tacit
                                  assets permitted.
reward_total               8 B  u64 LE — total emission budget (cleartext). Launcher's
                                  input UTXO at vin[1] is asserted to hold ≥ reward_total
                                  via the kernel sig + range proof on change.
reward_per_block           8 B  u64 LE — emission rate (reward_asset units per Bitcoin
                                  block).
start_height               4 B  u32 LE — earliest block height at which acc advances.
                                  Must satisfy current_height + 3 ≤ start_height
                                  ≤ current_height + AMM_FARM_MAX_START_DELAY.
end_height                 4 B  u32 LE — last block height at which acc advances
                                  (= start_height + reward_total / reward_per_block).
C_change_or_sentinel      33 B  Pedersen commitment of the launcher's change UTXO at
                                  vout[1], or the no-change sentinel (33 bytes 0x00)
                                  when the input is fully consumed. Same encoding
                                  rule as T_SWAP_VAR C_change_or_sentinel
                                  (SPEC.md §5.20).
range_proof              ~360 B  Aggregated bulletproof, m=1, over C_change_or_sentinel.
                                  Whole-input case uses the identity-point sentinel
                                  rule from T_SWAP_VAR (sentinel opens trivially to
                                  (value=0, blinding=0) and passes the range gate).
kernel_sig                64 B  BIP-340 over kernel_msg (defined below). Closes the
                                  reward-asset side: vin[1] input balanced against
                                  vout[1] change + cleartext reward_total absorbed
                                  into the virtual treasury.
launcher_sig              64 B  BIP-340 by launcher_pubkey over init_msg (defined
                                  below). Authorises the farm record.
```

Fixed-portion envelope payload: **316 bytes** + ~360 B range proof = **~676 bytes** total.

### Bitcoin tx layout (normative)

```
vin[0]    Envelope-bearing input (Taproot script-path); witness carries the payload.
vin[1]    Launcher's reward_asset UTXO. Pedersen-committed per CXFER convention;
          observable from vin[1]'s prior creation envelope. NOT opened in this
          envelope. Asset_id verified by walking vin[1]'s CXFER ancestry.
          Signed SIGHASH_ALL by launcher.
vin[2..]  Optional launcher BTC funding inputs for tx fee + dust budget.

vout[0]   OP_RETURN(envelope_hash) — 0 sat, 32-byte data.
vout[1]   Launcher's change UTXO — dust P2WPKH paying launcher's change address.
          Carries C_change_or_sentinel; asset class = reward_asset_id. Present
          iff the input strictly exceeded reward_total; otherwise omitted and the
          sentinel rule applies.
```

**No physical treasury UTXO is emitted.** The reward-asset value is
absorbed into the farm's virtual `treasury_remaining` balance, which
the indexer tracks as canonical state. This mirrors how `T_LP_ADD`
consumes `asset_A` / `asset_B` UTXOs and credits the pool's virtual
reserves — *"no UTXO holding pool funds, so there is no key that can
rug"* (`AMM.md`:1845).

### Derived identifier

```
farm_id = SHA256(
    "tacit-amm-farm-init-v1"
    || pool_id(32)
    || launcher_pubkey(33)
    || reward_asset_id(32)
    || farm_nonce(32)
)
```

`farm_id` is permanent and globally unique. Multiple farms against
the same pool are permitted; they accrue independent
`acc_reward_per_share` clocks against the shared `lp_asset_id`
ground truth.

### kernel_msg / init_msg

```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || pool_id(32)
    || farm_id(32)
    || vin[1].outpoint(36)
    || (C_change_or_sentinel(33) or vout[1].outpoint(36) — see SPEC.md §5.20 sentinel rule)
    || reward_total_LE(8)
)
```

Standard CXFER N=1 kernel-sig closure: the kernel sig demonstrates
the excess scalar `r_in − r_change` (or just `−r_in` in the
whole-input case) opens to a zero-value commitment given the
cleartext `reward_total`, asserting that the launcher contributed
exactly `reward_total` of `reward_asset_id` to the farm. The input
opening (`r_in`) is **not** revealed — the kernel-sig pattern is the
T_SWAP_VAR / T_AXFER_VAR construction verbatim, preserving the
launcher's wallet privacy on any portion of the input that exceeded
the contribution.

```
init_msg = SHA256(
    "tacit-amm-farm-init-v1"
    || farm_id(32)
    || launcher_pubkey(33)
    || reward_total_LE(8)
    || reward_per_block_LE(8)
    || start_height_LE(4)
    || end_height_LE(4)
    || envelope_hash(32)
)
```

`launcher_sig` is BIP-340 by `launcher_pubkey` over `init_msg`. It's
required so the launcher can be permanently attributed in the farm
record (useful for off-chain attribution UX) but **carries no
privileged authority post-init** — see below.

### Permissionlessness post-init

The farm record is immutable after `T_FARM_INIT` confirmation. The
`launcher_pubkey`:

- **Cannot** withdraw unspent treasury (treasury is virtual — there is
  no UTXO to spend, no key to sign, no path to recover).
- **Cannot** modify `reward_per_block`, `end_height`, `lp_asset_id`,
  or any other farm parameter.
- **Cannot** pause emissions.
- **Cannot** front-run bonders for preferential entry — the start
  gate `start_height ≥ current_height + 3` ensures any LP can bond
  before the first reward block.

The launcher's only post-init capability is publishing additional
`T_FARM_INIT` envelopes (creating *new* farms) — a permissionless
capability anyone else has equally.

### Canonical farm state (depth-3-confirmed)

| Field | Set by | Read by |
|---|---|---|
| `farm_id`, `pool_id`, `lp_asset_id`, `reward_asset_id`, `launcher_pubkey`, `reward_per_block`, `start_height`, `end_height` | `T_FARM_INIT` | every `T_LP_BOND` / `T_LP_UNBOND` against this farm |
| `acc_reward_per_share` (Q.96 unsigned, stored as u128) | every `T_LP_BOND` / `T_LP_UNBOND` (lazy crystallization) | next bond/unbond's accrual step |
| `total_bonded` (u64) | every `T_LP_BOND` (`+= bond_amount`) / `T_LP_UNBOND` (`-= bond.amount`) | next bond/unbond's per-share rate |
| `last_update_height` (u32) | every `T_LP_BOND` / `T_LP_UNBOND` | next bond/unbond's elapsed-blocks term |
| `treasury_remaining` (u64) | `T_FARM_INIT` (`= reward_total`); every `T_LP_UNBOND` (`-= reward_paid`) | conservation invariant + payout cap |

All five row entries are pinned at depth 3, identical discipline to
the `AMM.md` §"Pool state" baseline table.

`lp_asset_id` is **derived**, not stored separately:
`lp_asset_id = SHA256("tacit-amm-lp-v1" || pool_id)` per `AMM.md`
§"LP shares as a confidential tacit asset".

### Crystallization formula

Same arithmetic shape as Uniswap V2 `mintFee` (`AMM.md` §3352), but
indexed in Q.96 fixed-point rewards-per-share rather than as new LP
shares:

```
fn crystallize(farm, current_height):
    # Clamp the accrual window to the funded interval.
    h = min(current_height, farm.end_height)
    if h <= farm.last_update_height:
        return    # nothing to do (pre-start or already current)
    if h < farm.start_height:
        farm.last_update_height = h
        return    # pre-start: advance clock without emission

    elapsed = h - max(farm.last_update_height, farm.start_height)
    if farm.total_bonded > 0 and elapsed > 0:
        reward_units = elapsed * farm.reward_per_block
        # Q.96 fixed-point: multiply numerator by 2^96 before division.
        acc_delta    = (reward_units << 96) / farm.total_bonded
        farm.acc_reward_per_share += acc_delta

    farm.last_update_height = h
```

If `total_bonded == 0` during an interval, emissions are **forfeited**
— they don't accumulate against a future bonder. Same behaviour as
MasterChef. Documented and surfaced to launchers at `T_FARM_INIT`.

**Q.96 precision rationale.** With `reward_per_block ≤ 2^64`,
`elapsed ≤ 2^32`, and `total_bonded ≥ 1`, the numerator
`reward_units << 96` fits within u192. Pending-reward computation at
unbond produces a u192 intermediate; capped at u64 by the
`treasury_remaining` clamp. Indexers MUST implement the arithmetic in
BigInt (or u256) and only narrow to u64 at the final `payout`
assignment.

---

## §5.41 `T_LP_BOND` (`0x35`) — bond LP shares into a farm

### Pre-conditions

- `farm_id` resolves to a depth-3-confirmed farm record.
- `current_height < farm.end_height` (farm not exhausted; bonding past
  end is wasted gas and rejected to spare users the footgun).
- `bond_amount ≥ AMM_FARM_MIN_BOND` (`= 1000`, prevents dust-spam
  records; same numeric class as `MINIMUM_LIQUIDITY`).
- Bonder holds an `lp_asset_id` UTXO (or aggregated via prior
  `T_CXFER` to the bond size) where `lp_asset_id == farm.lp_asset_id`.

### Wire format

```
T_LP_BOND envelope payload:

envelope_version           1 B  = 0x01
opcode                     1 B  = 0x35
farm_id                   32 B
bonder_pubkey             33 B  compressed secp256k1. Wallet-discovery dust at vout[1]
                                  pays the x-only form of this key; unbonder must
                                  re-sign as this key.
bond_amount                8 B  u64 LE — staked LP shares (cleartext).
entry_acc_per_share       16 B  u128 LE — bonder's view of farm.acc_reward_per_share
                                  *post-crystallization-at-this-block*. Validator
                                  recomputes and rejects on mismatch (freshness gate;
                                  see "Freshness check" below).
bond_view_height           4 B  u32 LE — bonder's view of canonical height at intent
                                  time. Used for the freshness check; not stored
                                  in the bond record.
C_change_or_sentinel      33 B  Pedersen commitment of the bonder's change UTXO at
                                  vout[2], or the no-change sentinel when the LP
                                  input is fully consumed.
range_proof              ~360 B  Aggregated bulletproof, m=1, over
                                  C_change_or_sentinel. Same construction as
                                  T_FARM_INIT range_proof.
kernel_sig                64 B  BIP-340 over kernel_msg. Closes the LP-asset side:
                                  vin[1] input balanced against vout[2] change +
                                  cleartext bond_amount absorbed into farm.total_bonded.
bonder_sig                64 B  BIP-340 by bonder_pubkey over bond_msg.
```

Fixed-portion payload: **256 bytes** + ~360 B range proof = **~616 bytes** total.

### Bitcoin tx layout (normative)

```
vin[0]    Envelope-bearing input (settler / self-broadcast).
vin[1]    Bonder's lp_asset_id UTXO. Signed SIGHASH_ALL by bonder.
vin[2..]  Optional BTC funding inputs.

vout[0]   OP_RETURN(envelope_hash).
vout[1]   Bond-discovery dust UTXO — dust (e.g. 546 sat) P2WPKH paying the
          x-only form of bonder_pubkey. Carries NO Pedersen commitment, NO
          tacit asset class — it's a plain Bitcoin dust output whose only
          purpose is wallet discovery (scanHoldings can recognise bonds by
          encountering this dust at the bonder's discovery addresses).
          The outpoint of vout[1] is the canonical bond_id used by the
          worker's bond-record index and referenced by future T_LP_UNBOND.
vout[2]   Change UTXO — dust P2WPKH paying bonder's change address.
          Carries C_change_or_sentinel; asset class = lp_asset_id. Present
          iff the input strictly exceeded bond_amount; otherwise omitted.
```

**The LP shares at vin[1] are not held in any custody UTXO.** They
are consumed by the kernel sig and absorbed into `farm.total_bonded`
as a virtual balance. At unbond, the validator re-mints an
`lp_asset_id` UTXO of the same `bond_amount` by decree. The
canonical AMM pool's `lp_total_shares` (`S`) is **not** decremented
at bond — the bonder's notional LP position remains active in the
pool's `S`-denominated reserves accounting, so bonded shares
continue to earn AMM swap-fee compounding alongside farm emissions.

### kernel_msg / bond_msg

```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || farm_id(32)
    || vin[1].outpoint(36)
    || (C_change_or_sentinel(33) or vout[2].outpoint(36) — see SPEC.md §5.20 sentinel rule)
    || bond_amount_LE(8)
)
```

Standard CXFER N=1 closure on the LP-asset side: the kernel sig
demonstrates the excess scalar `r_in − r_change` opens to a zero-
value commitment given cleartext `bond_amount`, asserting the
bonder contributed exactly `bond_amount` of `lp_asset_id`. Input
opening (`r_in`) is **not** revealed; bonder's wallet privacy
preserved on any portion of the input that exceeded `bond_amount`.

```
bond_msg = SHA256(
    "tacit-amm-farm-bond-v1"
    || farm_id(32)
    || bonder_pubkey(33)
    || bond_amount_LE(8)
    || entry_acc_per_share_LE(16)
    || bond_view_height_LE(4)
    || envelope_hash(32)
)
```

### Freshness check

The validator pins farm state at depth 3, then recomputes:

```
canonical_height = min(current_confirmation_height - 3, farm.end_height)
crystallize(farm, canonical_height)
require: entry_acc_per_share == farm.acc_reward_per_share
require: bond_view_height ≥ canonical_height - AMM_FARM_VIEW_STALENESS
         (default AMM_FARM_VIEW_STALENESS = 6 blocks ≈ 1 h)
```

If `entry_acc_per_share` lags the canonical value, the validator
rejects. This forces bonders to re-broadcast against fresh state if
their tx sat in the mempool through a farm-mutating event from
another bonder — protects against an arbitrageur extracting value
from a stale entry snapshot.

### Bond record (indexed by `bond_id = vout[1].outpoint`)

```
bond_record:
    farm_id                : 32 B
    bond_amount            :  8 B  u64
    entry_acc_per_share    : 16 B  u128 (Q.96 snapshot at bond confirmation)
    bonder_pubkey          : 33 B
    bond_height            :  4 B  u32 (confirmation height of T_LP_BOND)
```

Bond records are append-only at confirmation, deleted by
`T_LP_UNBOND`, and read by `T_LP_UNBOND` only. No other opcode
references them.

**Note on the wallet-discovery dust at vout[1].** The dust UTXO can
be spent at the Bitcoin layer independently of `T_LP_UNBOND` (it's
just a P2WPKH dust output the bonder controls). Spending it does
**not** affect the bond record — the worker keys the bond by the
*outpoint* identity, not by the UTXO's continued existence on the
Bitcoin layer. Bonders who spend the dust early lose only the
wallet-discovery convenience; they can still unbond by referencing
`bond_id` directly. The worker exposes `/farm/:farm_id/bonds?bonder=:pubkey`
for outpoint-free discovery as a fallback (see "Indexer interface").

### State updates (post-confirmation, at depth 3)

1. Crystallize `farm` to `canonical_height` per §5.40 formula.
2. Verify `entry_acc_per_share == farm.acc_reward_per_share` (post-crystallization).
3. Index `bond_record` at `bond_id = vout[1].outpoint`.
4. `farm.total_bonded += bond_amount`.
5. `farm.last_update_height = canonical_height` (already set by crystallize; restated for clarity).

---

## §5.42 `T_LP_UNBOND` (`0x36`) — unbond and claim accrued rewards

### Pre-conditions

- `bond_id` resolves to a depth-3-confirmed bond record.
- `unbonder_pubkey == bond_record.bonder_pubkey` (no transfer
  mechanism in v1; see "Open questions" for follow-up
  transferability).
- Farm exists and is depth-3-confirmed; emissions may be exhausted
  (`treasury_remaining == 0`) — unbond still succeeds, just with
  zero payout if pending exceeds remaining.

### Wire format

```
T_LP_UNBOND envelope payload:

envelope_version           1 B  = 0x01
opcode                     1 B  = 0x36
farm_id                   32 B
bond_id                   36 B  outpoint reference (32-byte txid || 4-byte vout LE)
                                  identifying the bond record to settle.
unbonder_pubkey           33 B  compressed secp256k1. Must equal
                                  bond_record.bonder_pubkey.
exit_acc_per_share        16 B  u128 LE — unbonder's view of farm.acc_reward_per_share
                                  post-crystallization.
exit_view_height           4 B  u32 LE — unbonder's view of canonical height.
reward_amount              8 B  u64 LE — claimed reward payout. Validator recomputes:
                                    pending = bond_amount * (exit_acc - entry_acc) >> 96
                                    payout  = min(pending, farm.treasury_remaining)
                                  and requires reward_amount == payout.
lp_return_r               32 B  Opening scalar for the lp_return UTXO at vout[1].
                                  Validator emits lp_return_C = bond_amount · H +
                                  lp_return_r · G as the committed value. Bonder
                                  picks lp_return_r; revealing it here lets the
                                  bonder later spend the UTXO via CXFER (which
                                  rerandomizes the blinding factor downstream).
reward_r                  32 B  Opening scalar for the reward UTXO at vout[2].
                                  Validator emits reward_C = reward_amount · H +
                                  reward_r · G. Same role as lp_return_r.
unbonder_sig              64 B  BIP-340 by unbonder_pubkey over unbond_msg.
                                  Single authentication signature — no kernel
                                  sigs needed because there are no private
                                  commitments to close (all outputs are minted
                                  by validator decree with public openings).
```

Fixed payload: **259 bytes**. No bulletproof. No kernel sig.

### Bitcoin tx layout (normative)

```
vin[0]    Envelope-bearing input.
vin[1..]  Optional BTC funding inputs from the unbonder.

vout[0]   OP_RETURN(envelope_hash).
vout[1]   Re-emitted lp_asset_id UTXO — dust P2WPKH paying unbonder's address.
          Asset class = farm.lp_asset_id; value = bond_record.bond_amount;
          Pedersen commit = bond_amount · H + lp_return_r · G.
vout[2]   Reward UTXO — dust P2WPKH paying unbonder's address. Asset class =
          farm.reward_asset_id; value = reward_amount; Pedersen commit =
          reward_amount · H + reward_r · G. Omitted iff reward_amount == 0.
```

**No treasury inputs are consumed.** The reward-asset value is
minted at `vout[2]` by validator decree from the farm's virtual
`treasury_remaining` balance — the same mint-by-decree pattern used
by `T_LP_REMOVE` (which re-emits `asset_A` / `asset_B` from virtual
reserves) and `T_PROTOCOL_FEE_CLAIM` (which emits `lp_asset_id` from
the virtual share counter). Conservation is enforced by the worker
decrementing `treasury_remaining` and refusing payouts that exceed it.

### unbond_msg

```
unbond_msg = SHA256(
    "tacit-amm-farm-unbond-v1"
    || farm_id(32)
    || bond_id(36)
    || unbonder_pubkey(33)
    || exit_acc_per_share_LE(16)
    || exit_view_height_LE(4)
    || reward_amount_LE(8)
    || lp_return_r(32)
    || reward_r(32)
    || envelope_hash(32)
)
```

### State updates (post-confirmation, at depth 3)

1. Look up `bond_record` by `bond_id`. Reject if absent.
2. Verify `unbonder_pubkey == bond_record.bonder_pubkey`.
3. Crystallize `farm` to `canonical_height` per §5.40.
4. Verify `exit_acc_per_share == farm.acc_reward_per_share`.
5. Compute `pending = bond_record.bond_amount * (exit_acc - entry_acc) >> 96`
   (BigInt intermediate; truncate at final `payout` narrowing).
6. Compute `payout = min(pending, farm.treasury_remaining)`.
7. Verify `reward_amount == payout`.
8. Verify `unbonder_sig` against `unbond_msg` under `unbonder_pubkey`.
9. Emit `lp_return` UTXO at `vout[1]` with commit `bond_amount · H + lp_return_r · G`,
   asset_id = `farm.lp_asset_id`.
10. If `reward_amount > 0`: emit `reward` UTXO at `vout[2]` with commit
    `reward_amount · H + reward_r · G`, asset_id = `farm.reward_asset_id`.
11. `farm.total_bonded -= bond_record.bond_amount`.
12. `farm.treasury_remaining -= reward_amount`.
13. `farm.last_update_height = canonical_height` (restated).
14. Delete `bond_record`.

### Canonical block ordering

Within a Bitcoin block, `T_LP_UNBOND` envelopes apply in `(tx_index,
vin[0] outpoint)` order, per `AMM.md`:1746. Treasury exhaustion is
order-sensitive: two `T_LP_UNBOND` envelopes against the same farm
in the same block, each computing `pending > treasury_remaining`,
resolve such that the canonically-first envelope drains the
treasury and the second gets `payout = 0`. Bonders racing for
last-block emissions see this exactly the way MasterChef bonders
see end-of-emissions: deterministic, public ordering, no MEV
opportunity beyond what tip-revenue economics already capture.

---

## Conservation invariants (normative)

For any farm `F`, at any depth-3-confirmed height `h`:

1. **Treasury conservation.** `F.treasury_remaining + sum_over_unbonds(reward_amount_i) == F.reward_total`. (Treasury is virtual — there's no on-chain UTXO to misplace; the indexer's accounting is the canonical statement.)
2. **Bond conservation.** `F.total_bonded == sum_over_outstanding_bond_records(bond_amount)`.
3. **LP-asset conservation across bond/unbond cycle.** Each `T_LP_BOND` consumes `bond_amount` of `lp_asset_id` into virtual `F.total_bonded`; the matching `T_LP_UNBOND` mints exactly `bond_amount` of `lp_asset_id` back. Net LP-asset supply is unchanged across the cycle.
4. **No accrual without depth.** `F.acc_reward_per_share` advances only against `canonical_height = min(current_confirmation_height - 3, F.end_height)`.
5. **Emission cap.** `sum_over_unbonds(reward_amount_i) ≤ F.reward_total` — the `payout = min(pending, treasury_remaining)` clamp is the structural enforcement; the conservation invariant is the consequence.

Indexers MUST surface all five invariants as queryable assertions
on the `/farm/:farm_id` endpoint (see "Indexer interface" below).

---

## Constants

```
AMM_FARM_MIN_BOND               = 1000           # u64, MINIMUM_LIQUIDITY-class dust floor
AMM_FARM_MIN_REWARD_TOTAL       = 1_000_000_000  # u64, anti-spam dust floor on farm size
AMM_FARM_MAX_START_DELAY        = 4320           # ~30 days of blocks; bound on pre-start scheduling
AMM_FARM_VIEW_STALENESS         = 6              # blocks; freshness gate on bonder/unbonder view
ACC_FIXED_POINT_SHIFT           = 96             # Q.96 fixed-point for acc_reward_per_share
TACIT_FARM_DOMAIN_TAGS:
    "tacit-amm-farm-init-v1"                     # farm_id derivation + init_msg
    "tacit-amm-farm-bond-v1"                     # bond_msg
    "tacit-amm-farm-unbond-v1"                   # unbond_msg
```

Three domain tags total (down from five in the round-1 draft — the
`bond-receipt` and `treasury-sentinel` tags are eliminated by the
sanity-check revisions). All three reserved by this amendment;
merge gate requires a domain-tag collision audit against the full
`SPEC.md` inventory.

---

## Privacy model

| Quantity | Visible on chain | Notes |
|---|---|---|
| `bond_amount` per bond | ✅ public | Required for `total_bonded` accounting. |
| `reward_amount` per unbond | ✅ public | Required for `treasury_remaining` accounting. |
| `bonder_pubkey` per bond | ✅ public | Pinned in bond record; doubles as the unbond auth key. |
| `launcher_pubkey` per farm | ✅ public | Pinned in farm record. |
| `reward_total` per farm | ✅ public | Required for emission-schedule transparency. |
| Bonder's pre-bond wallet balance | ❌ hidden | Pedersen-committed LP UTXO; input opening not revealed. Kernel sig closes via excess scalar without leaking `r_in`. |
| Bonder's post-unbond wallet balance | ❌ hidden | Reward / LP-return UTXOs reblinded by downstream `T_CXFER` consumption. |
| Launcher's pre-init wallet balance | ❌ hidden | Same kernel-sig pattern; only `reward_total` is revealed, change stays private. |
| Bonder's identity | ❌ hidden (with mixer flow) | LP shares mixed via `T_DEPOSIT` → `T_WITHDRAW` upstream of `T_LP_BOND` break the linkability between the bonder pubkey and any prior LP-add action. |
| Bonds — transferable | ❌ not in v1 | See "Open questions"; v1 requires unbond + re-bond to reassign. |
| Farm-aggregate state | ✅ public | `total_bonded`, `acc_reward_per_share`, `treasury_remaining`, etc. — required for trustless validation. |

**Linkability surface.** A bonder who bonds from a pubkey previously
associated with any other activity (LP-add, swap, transfer) creates
a public linkage between that activity and the bond. The protocol-
level mitigation is mixer flow upstream: bonders SHOULD `T_DEPOSIT`
their LP shares, withdraw to a fresh address, and bond from that
fresh address. This matches the existing `AMM.md` §"LP shares as a
confidential tacit asset" guidance for any privacy-sensitive LP
activity.

**Aggregate-leak considerations.** If `total_bonded` is small and one
bonder dominates the farm, their `bond_amount` is inferable from
post-bond state deltas. Acceptable for v1 — same property holds for
swap volume in early `T_SWAP_VAR` pools. Mitigated naturally as
adoption grows; not load-bearing on protocol security.

---

## Bootstrap economics: TAC / cBTC.tac and cBTC.tac / cBTC.zk

The first wave of canonical farms targets the two structurally
important pairs for the tacit ecosystem:

### Farm A — TAC / cBTC.tac

**Pool:** the canonical TAC / cBTC.tac pool (any cBTC.tac denomination
tier per `SPEC-CBTC-TAC-AMENDMENT.md` §4). Already eligible for the
protocol-fee insurance-pool sentinel (`AMM.md` §"Insurance-pool
sentinel"), routing swap-fee skim directly into the cBTC.tac
insurance reserve.

**Reward asset:** TAC.

**Why this pair first:**

- TAC's primary on-chain utility is the cBTC.tac collateral layer.
  Depth in TAC / cBTC.tac is load-bearing for cBTC.tac price
  discovery and the liquidation path (`T_CBTC_TAC_FORCE_CLOSE`,
  `SPEC-CBTC-TAC-AMENDMENT.md` §5.38).
- A TAC-denominated farm on this pool aligns emission incentives with
  the asset whose utility depends on the pool's depth.
- The pool already routes a fraction of LP fees to the insurance pool
  via the sentinel — the farm reward stacks additively on top of
  that, giving LPs three concurrent yields: AMM swap fees (auto-
  compound), farm emissions (TAC), and indirect insurance-pool
  growth (which strengthens the cBTC.tac asset they're paired
  against).

**Suggested parameters (illustrative, not normative):**

- `reward_total`: launcher-determined; sized to span ≥ 90 days of
  emissions at the chosen rate.
- `reward_per_block`: launcher-determined; calibrated so that the
  emission APR at expected `total_bonded` is competitive with EVM
  yield-farm benchmarks (~10-30% APR equivalent) while staying
  conservative against TAC dilution.
- `start_height`: 24-48 hours after `T_FARM_INIT` broadcast, giving
  LPs time to position before the first reward block.
- `end_height`: implied by `reward_total / reward_per_block`.

### Farm B — cBTC.tac / cBTC.zk

**Pool:** cBTC.tac / cBTC.zk (any matching denomination tier).

**Reward asset:** TAC (or cBTC.tac at launcher's discretion).

**Why this pair second:**

- cBTC.tac / cBTC.zk is the canonical bridge between the wrapped-BTC
  derivative (cBTC.tac, exposes TAC-collateral upside) and the
  privacy-shielded base (cBTC.zk, the mixer-friendly UTXO form).
- Depth here is what makes "convert cBTC.zk to cBTC.tac" a
  thin-spread operation rather than a chain-of-OTC manoeuvre.
- LPs face minimal IL exposure since both assets track BTC at
  parity — emissions go further per dollar of incentive cost.

Both farms are spun up by anyone (including the protocol team, a
third-party launcher, or a community treasury) via a single
`T_FARM_INIT` broadcast with a TAC-denominated input. The protocol
does not privilege any particular launcher.

### Stacking with the protocol-fee insurance pool

For the TAC / cBTC.tac pool specifically, the protocol-fee mechanism
already accrues a portion of LP fees to the cBTC.tac insurance
reserve (`SPEC-CBTC-TAC-AMENDMENT.md` §"Insurance-pool sentinel
behaviour"). A farm against this pool is additive — the farm pays
TAC rewards from its independent treasury; the insurance-pool skim
continues to accrue against the same trades. LPs see:

```
LP yield = AMM fee compounding (less insurance skim)
         + farm emissions (TAC, from independent farm treasury)
```

The two reward streams have **no shared budget** and **no
interaction beyond the shared pool reserves**. Farm emissions are
not redirected through the insurance pool, and the insurance pool's
sentinel-driven inline `T_LP_REMOVE` (`AMM.md` §3486) is unaffected
by bonded shares — it operates against `lp_total_shares`, which
the farm doesn't mutate (bonded shares stay accounted in `S`).

---

## Indexer interface (informative)

`/farm/:farm_id` SHOULD return:

```json
{
  "farm_id": "0x...",
  "pool_id": "0x...",
  "lp_asset_id": "0x...",
  "reward_asset_id": "0x...",
  "launcher_pubkey": "0x...",
  "reward_total": "1000000000000",
  "reward_per_block": "10000000",
  "start_height": 873000,
  "end_height": 973000,
  "acc_reward_per_share_q96": "0x...",
  "total_bonded": "5000000",
  "last_update_height": 875200,
  "treasury_remaining": "780000000000",
  "current_height": 875203,
  "current_apr_bps_estimate": 1450
}
```

`current_apr_bps_estimate` is **informative only** — a heuristic
extrapolation that depends on off-chain price data. Wallets MUST NOT
rely on it for value-determining logic.

`/farm/:farm_id/bonds?bonder=:pubkey` SHOULD return the list of bond
records owned by `pubkey`, each with computed `pending_reward` at the
current canonical height. Pending reward is per-bond, not aggregated
across the farm. ScanHoldings uses this endpoint for outpoint-free
bond recovery (necessary when the wallet-discovery dust at the bond's
`vout[1]` has been spent or pruned).

`/farms?pool=:pool_id` SHOULD return all farms targeting a given pool.

---

## Reorg discipline

All `T_FARM_INIT` / `T_LP_BOND` / `T_LP_UNBOND` state mutations are
pinned at depth ≥ 3, identical to AMM pool-state mutations
(`AMM.md` §"Reorg discipline"). On a reorg deeper than 3, the
indexer rolls back farm state to the last common ancestor and
replays forward. Two specific cases warrant attention:

1. **Bond-then-unbond inside the reorg window.** If a bond at height
   `h_b` and an unbond at height `h_u > h_b` both fall inside a
   reorg from `h_r < h_b`, the indexer rolls back both, restores
   `farm.total_bonded -= bond_amount` and `farm.treasury_remaining
   += reward_amount`, and replays the post-reorg chain. The
   `bond_id` outpoint changes (the bond tx may not re-confirm); the
   bonder's wallet MUST re-scan and re-derive the new `bond_id`
   from the replayed bond tx (or query
   `/farm/:farm_id/bonds?bonder=:pubkey`).

2. **`T_FARM_INIT` inside the reorg window.** Farm record + virtual
   `treasury_remaining` both roll back. Any `T_LP_BOND` against a
   rolled-back farm is also rolled back (the worker can't index a
   bond against a non-existent farm). Bonders' LP UTXOs at `vin[1]`
   are restored to their pre-bond state, since the bond tx itself
   rolls back. Launcher's reward-asset UTXO at `vin[1]` of the
   rolled-back `T_FARM_INIT` is similarly restored.

The depth-3 gate ensures these cases never compose with confirmed
downstream activity — a 4-block reorg would have to revert
`T_FARM_INIT` plus 3+ blocks of confirmations, which is the same
extreme-reorg regime that breaks every depth-3-pinned AMM op. No
new vulnerability surface.

---

## Open questions for round-2 review

1. **Transferable bonds.** v1 has no transfer mechanism — to reassign
   a bond, the original bonder unbonds (forfeiting any future
   emissions to themselves) and the new owner re-bonds (resetting
   `entry_acc`). A follow-up amendment could add `T_LP_BOND_ASSIGN`
   that rewrites `bond_record.bonder_pubkey` under a signature from
   the current bonder + a destination pubkey. ~3 new fields, no
   accrual interaction. Plausible follow-up if secondary-market
   demand for bonds materialises.

2. **Lock multipliers / boost curves.** This draft ships **no**
   lock-bonus mechanism — every bond is 1x. Adding `unlock_height`
   to the bond record with a linear-bonus curve
   (`multiplier = 1 + min((unlock_height - bond_height) / MAX_LOCK_BLOCKS, MAX_BOOST - 1)`)
   would let LPs commit to longer holds in exchange for higher
   emission share. This is the veCRV-style mechanism. Adds ~24 bytes
   to the bond record and an `unlock_height` gate at unbond. Lower-
   priority than getting the unmultipliered version shipped; flagged
   for a follow-up amendment.

3. **Batched unbond (`T_LP_UNBOND_MULTI`).** A bonder with N bond
   records pays N tx fees to unbond all positions. A batched variant
   (multiple `bond_id` references in one envelope) cuts that to one
   tx — comparable to the `T_AXFER` batched-preauth amendment's gas
   savings. Plausible follow-up.

4. **Farm-init capability flags.** A `capability_flags` byte on
   `T_FARM_INIT` would allow opting into / out of transferable
   bonds, lock multipliers, etc. without consuming more opcodes.
   Reserved for the follow-up that adds the first capability bit.

5. **Per-pool farm allocation weights.** MasterChef's `allocPoint`
   model splits a single emission budget across N pools by weight.
   This draft instead expects each pool to have its own
   `T_FARM_INIT` with an independent treasury — simpler, more
   permissionless, no central allocator role. The tradeoff is that
   launchers can't trivially rebalance across pools; they'd have to
   spin up new farms (and accept that the old farms continue
   emitting until exhausted). Acceptable for v1; an allocator
   opcode is a clear follow-up if the simpler model proves too
   rigid.

6. **Multi-asset rewards.** Single `reward_asset_id` per farm in
   this draft. Two-token farms (e.g., TAC + cBTC.tac dual
   emissions) would require two parallel farms against the same
   pool, which works but doubles the `T_LP_BOND` cost per bonder.
   A future `T_LP_BOND_MULTI_FARM` could let a bonder join N farms
   in one envelope; not blocking for v1.

7. **Domain-tag collision audit.** The three new domain tags listed
   under "Constants" need to be cross-checked against the full
   `SPEC.md` tag inventory before merge. Mechanical audit; not a
   design risk.

8. **`bond_amount` dust-spam griefing.** A spammer could chain
   `AMM_FARM_MIN_BOND`-sized bonds to inflate the bond-record
   table. The min-bond floor + per-tx Bitcoin fee are partial
   mitigations; per-bonder bond-record-count limits or a per-bond
   tx-fee scaling curve could be added if observed in practice.
   Defer to monitoring.

9. **Cross-farm composability with `T_SWAP_ROUTE`.** A user routing
   through a pool whose LP shares are bonded sees zero direct
   interaction — `T_SWAP_ROUTE` operates against pool reserves,
   not bonded shares. Worth a one-line confirmation in the
   `SPEC-SWAP-ROUTE-AMENDMENT.md` cross-reference.

---

## Merge criteria

- [ ] Reference implementation: `tests/amm-farm.mjs` covering
      `T_FARM_INIT` / `T_LP_BOND` / `T_LP_UNBOND` envelope build +
      validator + accrual math + reorg roll-forward.
- [ ] Wire-format roundtrip tests: encode → decode → re-encode
      byte-identity across all three opcodes.
- [ ] Adversarial tests: stale entry_acc, oversized reward_amount,
      under-funded treasury, replayed bond_id, cross-farm bond_id
      confusion, post-end-height bonding attempt, dust-floor
      bypass attempt.
- [ ] Property fuzz: random sequences of `T_FARM_INIT` / `T_LP_BOND`
      / `T_LP_UNBOND` against a reference oracle computing pending
      rewards from first principles. ≥10k random traces,
      conservation invariants 1–5 hold.
- [ ] Signet on-chain harness: full bond-emit-unbond cycle confirmed
      on signet across at least two farms (single-pool and
      cross-pool).
- [ ] Domain-tag collision audit (open question 7) closed.
- [ ] SPEC.md §1.1 opcode table entries for `0x34` / `0x35` / `0x36`.
- [ ] SPEC.md §5.40 / §5.41 / §5.42 (or finalised section numbers)
      authoritative-text merge.
- [ ] AMM.md §"Pool state" baseline table updated to note that
      bonded LP shares stay accounted in `S`.

No coupling to the AMM Phase-2 ceremony. No coupling to the
`T_TRADE_BATCH` (`0x39`) draft. No coupling to the `T_RANGE_ATTEST`
(`0x3A`) draft. Ships as an independent additive amendment under the
`SPEC.md` §5.5 unknown-opcode rule.

---

## Tracker notes

- **2026-05-18 (round-1 initial)** — Three-opcode design proposed.
  Original draft used NUMS-sentinel on-chain treasury UTXOs with
  worker-enforced spends, fungible bond-receipt asset class with
  `T_CXFER` pubkey-rotation, m=2/m=3 bulletproofs on both bond and
  unbond, separate kernel sigs on each asset side.
- **2026-05-18 (round-1 sanity-check pass)** — Sanity check against
  existing tacit primitives identified five corrections (see
  status banner). Treasury moved to virtual bookkeeping (matching
  AMM reserves, mixer pool, cBTC.tac insurance — *"no UTXO holding
  pool funds, so there is no key that can rug"*, `AMM.md`:1845).
  Bond receipts demoted to plain P2WPKH dust markers (no Pedersen,
  no asset class, no `T_CXFER` interaction). Input openings
  dropped to match `T_SWAP_VAR` privacy pattern. Bulletproofs
  reduced to m=1 on change for `T_FARM_INIT` / `T_LP_BOND`; none
  for `T_LP_UNBOND`. Single sig on `T_LP_UNBOND` (kernel sigs
  redundant when all openings public). Net wire weight: ~3.1 KB
  → ~1.5 KB across the three opcodes. Bootstrap target unchanged:
  TAC / cBTC.tac and cBTC.tac / cBTC.zk pair pools.
