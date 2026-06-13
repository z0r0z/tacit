# DESIGN — cBTC.tac: real-BTC-backed, oracle-free peg (the authoritative design)

> **STATUS: this is the cBTC.tac architecture of record.** cBTC.tac is a **fungible claim on real BTC
> locked in cBTC.zk locks** — the tETH pattern (lock/bridge an asset → mint a fungible claim) applied to
> Bitcoin. The peg is **trustless** (conservation, no price, no oracle); the (TAC, tETH) bond is demoted
> from "the backing" to a **custody-insurance backstop** whose trigger is **reflection-proven**, not
> oracle-attested. **Supersedes the CDP framing in [`DESIGN-cbtc-tac-bond-guest.md`](./DESIGN-cbtc-tac-bond-guest.md)**
> (its §5 price oracle was in the critical mint path — removed here; its `bond_position`/lien machinery is
> *repurposed* as the insurance vault below). Builds on the peg foundation in
> [`DESIGN-cbtc-sats-lock-reflection.md`](./DESIGN-cbtc-sats-lock-reflection.md) (`fold_cbtc_lock`, built).
>
> **Why this shape:** a BTC-pegged synthetic minted against a (TAC, tETH) bond *needs* a BTC price, and
> that price is irreducibly a trust/manipulation surface (the (TAC,tETH) pool gives the ratio but not the
> BTC anchor; the existing TAC/BTC source is a worker TWAP — a key/operational trust). Backing cBTC.tac
> with **real locked BTC** removes the price from the path that mints value, so a mis-price can never
> create unbacked cBTC.tac. The trust that remains is **BTC custody** (could the locked sats be moved?) —
> a one-time *construction* decision (protocol-key → MPC → covenant), not a daily signing secret.

## 1. The model

```
lock BTC (cBTC.zk lock at CBTC_VAULT_SPK)
        │  reflection proves the lock (fold_cbtc_lock: cBTC value == locked sats, conservation)
        ▼
   cBTC note enters the pool  ──fungible layer (canonical ERC20 + pool, like any asset)──▶  cBTC.tac
        │
        └─ redeem: burn cBTC.tac (ν spent) + the vault releases the sats (gated by the vault, §3)
```

**Peg invariant (trustless):** total cBTC.tac ≤ total live locked sats, by construction — every unit
enters only via `fold_cbtc_lock`, which requires a confirmed, equal-value, single-use vault lock, and
redemption removes the note and the lock together. **No oracle. No price. No bond in the mint path.**

## 2. The peg path — already mostly built

- **Issuance** = the cBTC.zk sats-lock value-entry: `ScanReflection::fold_cbtc_lock` (cxfer-core, built +
  KAT'd; skip-not-panic) + the `reflect.rs` `0x66` dispatch (in the reflection guest). The minted note's
  **fungible form is cBTC.tac** — a canonical ERC20 + pool, the same machinery every Tacit asset has, no
  new op.
- **Redemption** = burn the cBTC.tac note (a normal spend → `ν` in the spent set) + spend the vault output
  (release sats), atomically bound by the vault validator (§3). The reflection reflects both, so the peg
  invariant holds across redemption.
- **Remaining to make it live:** finalize `CBTC_VAULT_SPK` (§3, the vault construction) + `CBTC_ZK_ASSET_ID`
  (a domain constant I derive — cBTC.zk is a lock position, not a real etch), wire the witness assembler,
  and a reflection re-prove. **No settle-guest op, no oracle.**

## 3. The only residual trust — BTC custody ("could the locked sats be moved?")

`fold_cbtc_lock` proves the lock *exists and backs the value*; it does not by itself stop the vault from
moving the sats while cBTC.tac circulates. Three handlers, best → interim:
1. **Covenant vault (endgame, trustless).** `CBTC_VAULT_SPK` is a covenant (CTV/OP_VAULT) that *enforces*
   spend-only-into-redemption → the sats **cannot** be moved → no insurance, no oracle, fully trustless.
   cBTC.zk's structural edge over a wBTC/tBTC: the lock is native + reflection-provable, so this is a
   clean upgrade, not a re-architecture.
2. **Protocol-key / MPC vault + Ethereum contracts (THE LAUNCH PATH).** `CBTC_VAULT_SPK` is a protocol P2TR
   (`0x5120‖vaultPubkey`), redemption-enforced by the validator; MPC the key + slash the custodians. The
   key *could* move the sats, so the mature **Ethereum contracts** carry the risk — the (TAC, tETH)
   `InsuranceVault` backstop (§4) + the DAO + `cbtcBackingSats`. **Rationale:** this leans on *battle-tested
   Ethereum-contract trust + a simple, slashable Bitcoin key*, rather than a *novel Bitcoin construction* —
   the lower-risk trade for now. (The trustless-Bitcoin alternative — an adaptor-locked redemption vault —
   exists but carries its own novel-crypto risk; deferred to `DESIGN-cbtc-vault-custody.md`, the
   post-covenant / risk-warranted option.)
3. **Accept-and-document** the launch posture (#2), covenant (#1) as the endgame that retires the Ethereum
   scaffolding — the same discipline as the reorg / reflection-finality cruxes.

Same custody-trust *shape* as tETH (which trusts its bridge), with cBTC.zk *better* placed because the
custody is covenant-upgradeable — and, in the meantime, hedged by transparent Ethereum contracts rather
than a custodian's word.

## 4. The insurance backstop — a simple Ethereum `InsuranceVault` (Solady `Ownable`), NOT guest ops

The custody risk of §3.2 is covered by a **standalone, minimal Ethereum contract** — not confidential
guest ops. That keeps the core `ConfidentialPool` **immutable + admin-free** (the vault *reads* the pool +
the reflection, never modifies the core), and makes the one tunable number a *contract variable* (no
re-prove to change it). So the confidential-bond guest layer in `DESIGN-cbtc-tac-bond-guest.md` (the §5
oracle, `bond_position_leaf`, the lien/redeem/slash ops) is **superseded for cBTC.tac** — its primitives
stay valid + tested if a *confidential* bond is ever wanted elsewhere, but cBTC.tac's insurance is a
transparent contract, which is simpler and the right shape for a backstop.

**`InsuranceVault` = Solady `Ownable`, deliberately minimal.** Owner = the deployer (you) to start;
`transferOwnership(dao)` when ready — no Governor/timelock up front. The owner sets the sizing and manages
capital, **bounded by construction**: it can only size the buyback + hold/withdraw *insurance capital* —
it **cannot mint cBTC.tac, move the BTC backing, or break the peg** (conservation forbids that). So the
owner's worst case is an under-funded or drained *backstop*, never broken money (the peg is still real BTC).
- **Hold:** escrow (TAC, tETH) capital (canonical ERC20s). Anyone can fund it; owner withdraws (launch).
- **Claim → buy-and-sequester (permissionless to trigger):** the pool exposes a **reflection-attested**
  `cbtcBackingSats()` (the live locked sats behind cBTC.tac — the reflection tracks the cBTC.zk vault
  outpoints). When *circulating* cBTC.tac (`totalSupply − vaultHeld`) exceeds backing (a lock was moved
  without redemption), the vault **buys cBTC.tac off the AMM and SEQUESTERS it** — holding it, dropping
  circulating back to ≤ backing. (Buy-and-sequester, *not* burn: the canonical ERC20's `burn` is
  minter-gated to the pool, so the vault holds the bought cBTC.tac instead — the loss is socialized to the
  insurance capital. Optional cleanup-burn later if a self-burn is added.) The shortfall is read from
  `BITCOIN_RELAY_VKEY`-verified state, **not asserted by the caller**, and the buy auto-closes it (no core
  mutation, just a view). Public, market-wide (no holder identification), no confidentiality touched — the
  trigger is a **proof**, not an oracle call.
- **Size:** `onlyOwner` params — a coverage ratio + a slow TAC/BTC reference (`satsPerTacRef`) for sizing
  the spend, + a per-claim cap. Updated whenever; read at claim time. **No hot key, no re-prove.**

**Path:** you admin to start → `transferOwnership` to a DAO later (an Ethereum Governor voting with the
canonical cTAC; Bitcoin-native governance the further step). TAC governance then has real utility (sizing
the backstop + the §3.2 vault MPC set) *without* TAC being per-unit BTC collateral — the peg is real BTC;
TAC governs the *insurance*. TAC value stays from governance/fees/bonding, not reflexive BTC backing.

## 5. The trust ledger (what's trusted, where)
| Concern | Mechanism | Trust |
|---|---|---|
| cBTC.tac = real BTC (peg) | `fold_cbtc_lock` conservation | **none** (proof) |
| No double-mint / inflation | lock single-use + nullifiers | **none** (proof) |
| Sats stay locked until redeem | vault construction (§3); MPC set + slashing = TAC governance | **construction** (covenant = none; key/MPC = bounded, gov-managed) |
| Insurance claim is real | reflection-attested `cbtcBackingSats` vs supply | **none** (proof) |
| Insurance sizing + capital | `InsuranceVault` owner (you → DAO), Solady `Ownable` | **soft + bounded** (worst case = under-funded/drained *backstop*; can't mint or break the peg) |

**No daily signing key anywhere.** The peg is conservation; the claim is a proof; the two residual roles
(backstop sizing, custody set) are **slow, transparent, bounded TAC-governance actions**, and the covenant
vault retires the custody one. Governance's worst case is an under-funded backstop — never a broken peg.

## 6. What's built vs remaining
- **Built (cxfer-core, tested):** `fold_cbtc_lock` (the peg value-entry). The `bond_position_leaf`/§5
  primitives are NOT needed for cBTC.tac (the insurance is contract-side) — they stand for a possible
  future *confidential* bond elsewhere.
- **Decide / provide:** `CBTC_VAULT_SPK` (the vault — protocol-key P2TR for launch, covenant later; needs
  the vault pubkey); `CBTC_ZK_ASSET_ID` (I derive a domain constant).
- **Build — reflection/guest (rides the cBTC.zk re-prove):** finalize the cBTC.zk constants + the witness
  assembler; expose **`cbtcBackingSats`** (the live locked sats behind cBTC.tac = the sum of live cBTC.zk
  vault outpoints) in the reflection public values so the contract surfaces it for the vault's claim.
- **Build — contract/app (no re-prove, no core change):** the fungible cBTC.tac layer (canonical ERC20 —
  exists for any asset) + the redemption flow; the `InsuranceVault` (Solady `Ownable`, §4 + appendix);
  the covenant-vault upgrade path.
- **Re-prove:** the **reflection guest only** (the cBTC.zk constants + `cbtcBackingSats`). The settle guest
  is untouched by cBTC.tac now (no bond ops) — it re-proves only if the adaptor / other settle work rides
  along.

## 7. Net
cBTC.tac is a **real-BTC-backed, oracle-free, trustlessly-pegged** wrapped BTC: lock-claim for the peg
(`fold_cbtc_lock`, done), custody handled by a vault that upgrades protocol-key → MPC → covenant, and a
(TAC, tETH) **insurance** backstop with a **proof-triggered** claim and only a soft, optional price knob on
the payout. The oracle leaves every path that mints or secures value — exactly the trust-minimization the
design was reaching for, with the covenant vault as the trustless endgame.

## Appendix — `InsuranceVault` (Solady `Ownable`)

> **IMPLEMENTED: `contracts/src/InsuranceVault.sol` + `contracts/test/InsuranceVault.t.sol` (8 forge tests
> green).** The shipped contract refines the sketch below: the claim is **`coverShortfall`** (buy + the
> shortfall calc above) and uses **buy-and-sequester** rather than burn (the canonical ERC20 `burn` is
> minter-gated), with owner ceilings `maxBuybackPerClaim` + `maxCapitalPerClaim` bounding the
> permissionless trigger, and an injected `IInsuranceRouter` (venue-agnostic — a public-AMM or
> confidential-pool adapter wired at deploy). The sketch below is the design intent.
>
> Minimal by design: owner = you to start, `transferOwnership(dao)` later. The owner sizes the buyback +
> manages capital; it **cannot** mint cBTC.tac, move the BTC backing, or break the peg. The claim trigger
> is the reflection-attested shortfall (`POOL.cbtcBackingSats()` vs `cBTC.tac` supply), not a caller claim
> or an oracle. No change to the immutable `ConfidentialPool` beyond the read-only `cbtcBackingSats` view
> the reflection already needs to feed.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IPoolBacking { function cbtcBackingSats() external view returns (uint256); } // reflection-attested
interface IMintBurn   { function burn(address from, uint256 amount) external; }
interface IERC20Supply { function totalSupply() external view returns (uint256); }

/// @notice Custody-insurance backstop for cBTC.tac. Holds (TAC, tETH) and, on a reflection-proven peg
///         shortfall (locked BTC moved without redemption), buys cBTC.tac off the AMM and burns it to
///         restore `cBTC.tac supply <= locked sats`. The peg is trustless (conservation in fold_cbtc_lock);
///         this only covers the §3 custody risk. BOUNDED: the owner sizes the buyback + manages capital,
///         never mints cBTC.tac, moves the backing, or breaks the peg.
contract InsuranceVault is Ownable {
    IPoolBacking public immutable POOL;     // exposes cbtcBackingSats() from BITCOIN_RELAY_VKEY-verified state
    address public immutable CBTC_TAC;      // the cBTC.tac canonical ERC20 (same unit as backing sats)
    address public immutable TAC;           // backstop capital legs
    address public immutable TETH;

    // governable sizing (onlyOwner; owner = you -> DAO)
    uint256 public coverageBps;             // target backstop = coverageBps/1e4 of outstanding cBTC.tac value
    uint256 public satsPerTacRef;           // slow TAC/BTC reference used to size the capital spend
    uint256 public maxBuybackPerClaim;      // per-claim cap (bounds a spurious/again-and-again trigger)

    event ParamsSet(uint256 coverageBps, uint256 satsPerTacRef, uint256 maxBuybackPerClaim);
    event CapitalAdded(address indexed leg, uint256 amount);
    event CapitalWithdrawn(address indexed leg, uint256 amount, address to);
    event ClaimPaid(uint256 shortfall, uint256 cbtcBurned, uint256 capitalSpent);

    constructor(address pool, address cbtcTac, address tac, address teth, address admin) {
        POOL = IPoolBacking(pool); CBTC_TAC = cbtcTac; TAC = tac; TETH = teth;
        _initializeOwner(admin); // Solady: you to start; transferOwnership(dao) when ready
    }

    // --- capital ---
    function addCapital(address leg, uint256 amount) external {            // anyone may fund the backstop
        require(leg == TAC || leg == TETH, "leg");
        SafeTransferLib.safeTransferFrom(leg, msg.sender, address(this), amount);
        emit CapitalAdded(leg, amount);
    }
    function withdrawCapital(address leg, uint256 amount, address to) external onlyOwner { // bounded: capital only
        SafeTransferLib.safeTransfer(leg, to, amount);
        emit CapitalWithdrawn(leg, amount, to);
    }

    // --- governable sizing ---
    function setParams(uint256 _coverageBps, uint256 _satsPerTacRef, uint256 _maxBuyback) external onlyOwner {
        coverageBps = _coverageBps; satsPerTacRef = _satsPerTacRef; maxBuybackPerClaim = _maxBuyback;
        emit ParamsSet(_coverageBps, _satsPerTacRef, _maxBuyback);
    }

    // --- claim: reflection-proven shortfall -> buyback + burn (permissionless to trigger) ---
    function claim(bytes calldata buybackRoute) external {
        uint256 backing = POOL.cbtcBackingSats();                 // live locked sats (reflection-attested)
        uint256 supply  = IERC20Supply(CBTC_TAC).totalSupply();   // matching unit
        require(supply > backing, "no shortfall");                // NOT a caller assertion — proven state
        uint256 shortfall = supply - backing;
        uint256 toBurn = shortfall < maxBuybackPerClaim ? shortfall : maxBuybackPerClaim;
        uint256 spent = _buyCbtcWithCapital(toBurn, satsPerTacRef, buybackRoute); // (TAC,tETH) -> cBTC.tac via AMM
        IMintBurn(CBTC_TAC).burn(address(this), toBurn);          // supply drops -> shortfall auto-closes
        emit ClaimPaid(shortfall, toBurn, spent);
    }

    /// Route the (TAC, tETH) capital through the AMM to acquire `toBurn` cBTC.tac, sized by satsPerTacRef.
    /// Impl TBD (confidential or public AMM path); returns capital spent. Slippage-bounded by coverageBps.
    function _buyCbtcWithCapital(uint256 toBurn, uint256 ref, bytes calldata route) internal returns (uint256);
}
```

**One coordinated addition** (read-only, rides the cBTC.zk reflection re-prove): `ConfidentialPool` exposes
`cbtcBackingSats()` = the reflection-attested sum of live cBTC.zk vault outpoints. Everything else is a
self-contained, ownable contract that the core never depends on.
