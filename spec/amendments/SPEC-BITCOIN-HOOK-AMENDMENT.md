# SPEC Amendment — Hooked `bridge_mint`: Bitcoin-triggered Ethereum calls as a V2-style callback

> **STATUS** (2026-06-20). **Mode B (value-free reflected call, §1.4) is IMPLEMENTED** on the
> `confidential-transfer-nm` branch — guest (`parse_btc_call_envelope` + `fold_btc_call` + the `reflect.rs`
> fold + KAT), contract (`pendingBtcCall` + the attest record loop, codesize-reclaimed back under EIP-170),
> and the `BtcCallExecutor` sidecar (6 tests green); the e2e attest-record round-trip is covered
> (`test_attest_records_btc_calls`). Rides the coordinated reflection re-prove (`BITCOIN_RELAY_VKEY`).
> **Mode A (value-bound hook on `OP_BRIDGE_MINT`, §1) remains a DRAFT follow-up.** Remaining for Mode B is
> dapp UX only: a `0x68` envelope tx-builder (Schnorr-sign the call) + an `executeBtcCall` driver. (The
> reflect-exec DIGEST_MATCH mirror needs no change — `btcCallsFolded` is not in `state.digest()`, and the
> harness reads `newDigest` at a fixed word index that the appended field doesn't shift.)
>
> Adds an **optional callback to the existing `OP_BRIDGE_MINT`** — not a new op — so a proven Bitcoin burn
> can trigger an arbitrary Ethereum contract call with the bridged value, while preserving bounded authority.
> Modeled on Uniswap V2's `swap()`: the same path that already proves the burn and mints the value gains one
> optional `if (hookTarget != 0) target.onBitcoinReflect(…)` bolted on **after** state commits — the
> flash-swap shape, where the optimistic effect (the mint) is already done and the invariant (conservation)
> is already proven before the callee runs.
>
> **Why a callback on `bridge_mint`, not `OP_BTC_HOOK`:** a hook needs exactly what `bridge_mint` already
> produces — a proven burn + a conserved value. A standalone op would re-implement the burn-verify path,
> add a new op code, a new struct family, and a new value leg — ~400–600 B of contract code the pool does
> not have (26 B of EIP-170 headroom, §6). The callback reuses the burn proof, the value, and the
> nullifier verbatim, so the marginal surface is one small PV array + one guarded call.
>
> Builds on: `SPEC-BITCOIN-REFLECTION-AMENDMENT.md` (trustless Bitcoin-state reflection);
> `DESIGN-confidential-defi-v1.md` §0/§4.4 (minimal-core / mutable-policy + the `ICdpController` callback
> seam this mirrors); `OP_BRIDGE_MINT` (`main.rs:436`, the path extended here).

## 0. Thesis — the programmable layer, as a flash callback

The immutable core proves **structure + conservation**; policy lives in mutable Ethereum contracts. A
`bridge_mint` already lands a conserved, Bitcoin-burn-backed value as an Ethereum note. The hook adds:
"and, optionally, after committing that, call a contract the burn named." That single optional callback —
the V2-`swap()`-with-`data` shape — turns "Ethereum is the programmable layer over Bitcoin" from a typed
special case (CDP, cBTC mint) into a general capability, with no new op and no widened trust boundary.

**Two modes**, by whether the call carries value:
- **Mode A — value-bound hook on `bridge_mint`** (§1): you bridge a real asset *and* trigger a call,
  atomically, in settle. Needs a Tacit note. "Bring value **and** trigger."
- **Mode B — value-free reflected call** (§1.4): a confirmed, signed Bitcoin tx commits a call; the
  *reflection* proves it; Ethereum fires it. **No Tacit asset, no mint, `value = 0`.** Any BTC holder
  programs Ethereum by signing a Bitcoin tx. "Trigger only."

The irreducible requirement in both is a real, confirmed, user-signed Bitcoin transaction that commits the
call — that signature + confirmation is what makes it *Bitcoin-authorized* rather than just an Ethereum
call. What Mode B drops is the asset and the mint, not the Bitcoin authorization.

## 1. Mode A — value-bound hook on `OP_BRIDGE_MINT`

### 1.1 Bitcoin side (extended burn envelope)
The cross-chain burn envelope (`OP_ENV_CONF_BURN`) optionally appends `(hook_target[20], calldata_hash[32])`
after its existing `destCommitment`. `hook_target == 0` (the default) is a plain bridge_mint, unchanged.
`calldata_hash = keccak256(calldata)` — only the **hash** rides Bitcoin (block space is scarce); the full
calldata rides Ethereum-side (§1.3) and is checked against the hash on-chain. The burn-set value still pins
`destCommitment`, so the burn authorizes *both* the mint destination *and* the specific call.

### 1.2 Guest (`OP_BRIDGE_MINT`, `main.rs:436`)
After the unchanged burn-verify + `leaves.push(dest_leaf)` / `nullifiers.push(nu)` / `bitcoin_burns.push(nu)`
(`main.rs:504`), read the optional hook and, if present, surface it. The bridged value is revealed as a
**public boundary amount** (owner stays confidential — same boundary as CDP `value_i`/`debt_value`), reusing
the CDP value-opening so `onBitcoinReflect` receives a cleartext `value`:

```rust
// Optional hook (V2-swap shape): the burn envelope may name a contract to call after the mint commits.
let hook_target = r20();                       // 20-byte address; [0;20] = plain bridge_mint (unchanged)
if hook_target != [0u8; 20] {
    let calldata_hash = r32();                 // keccak(calldata), bound into the burn envelope on Bitcoin
    let v_mint: u64 = io::read();              // public boundary value
    let v_blind = r32();
    assert!(open_value(&out_pt, v_mint, &v_blind), "bridge_mint hook: value opening"); // reuse CDP opening
    btc_hooks.push(BtcHook { target: hook_target, calldata_hash, value: v_mint, burn_nullifier: nu });
}
```

`btc_hooks: Vec<BtcHook>` is a new accumulator (alongside `cdp_mints` at `main.rs:252`) appended to the
committed public values; `BtcHook { target:[u8;20], calldata_hash:[u8;32], value:u64, burn_nullifier:[u8;32] }`.
No change to the burn membership / conservation / one-mint-per-ν logic.

### 1.3 Contract (`ConfidentialPool`)
The calldata travels in a new `bytes[] calldata hookData` arg (the V2 `data` analog) — **not** `memos`, which
are positionally bound one-per-leaf (`settle` docstring, `:1474`). One `hookData[i]` per `pv.btcHooks[i]`.
The callback fires at the **very end of `_settle`**, after every state write (leaves, `bridgeMinted`, roots,
nullifier floor), so CEI holds and the global `ReentrancyGuardTransient` (`:105`) is held throughout:

```solidity
interface IBitcoinHook {
    function onBitcoinReflect(bytes calldata data, uint256 value, bytes32 burnNullifier) external;
}

// end of _settle, after all state committed
for (uint256 i; i < pv.btcHooks.length; ++i) {
    BtcHook memory h = pv.btcHooks[i];
    if (keccak256(hookData[i]) != h.calldataHash) revert BadHookCalldata();
    IBitcoinHook(h.target).onBitcoinReflect(hookData[i], h.value, h.burnNullifier);
}
```

`settle` gains the `hookData` arg (pre-launch entrypoint change is acceptable; live only on Sepolia). When a
batch has no hooks, `pv.btcHooks` is empty and `hookData` is empty — zero extra cost on the common path.

### 1.4 Mode B — value-free Reflected Bitcoin Call (no Tacit asset, reflection-fold)
A pure call needs no asset and no mint — only a confirmed, signed Bitcoin tx that commits the call. Its home
is the **reflection guest** (`reflect.rs`), which already proves arbitrary Bitcoin txs onto Ethereum, not
settle's `bridge_mint`.

**Bitcoin side (as built):** a `T_BTC_CALL` (`0x68`) **witness-carried** envelope — read like every other
Tacit envelope via `extract_taproot_envelope`, authenticated by the in-branch BIP141 witness-commitment gate
(`reflect.rs:419`), so no separate `OP_RETURN` path is needed. Fixed **201-byte** layout:
`executor(20) ‖ target(20) ‖ calldata_hash(32) ‖ caller_pubkey(32, x-only) ‖ call_nonce(32) ‖ sig(64)`. The
BIP-340 `sig` by `caller_pubkey` is over
`keccak("tacit-btc-call-v1" ‖ executor ‖ target ‖ calldata_hash ‖ caller_pubkey ‖ call_nonce)`. Block
inclusion + the signature prove a Bitcoin party authorized exactly this call. **Three bindings**, each closing
a replay axis: the `"tacit-btc-call-v1"` **domain tag** (a btc-call sig can't be replayed as a kernel/other-
protocol sig); the `call_nonce` → `callId` (per-caller one-shot); and the `executor` address (the specific
`BtcCallExecutor` the caller authorizes — pins the call to one deployment, chain *and* pool, so the same
envelope folded by any other pool can never fire on a different executor). The executor is bound in *both* the
signed message (a relayer can't re-target) and the `recordHash` (a different executor reverts), and needs no
guest-side deployment constant — the executor supplies its own `address(this)` on the firing side.

**Guest (as built):** `bitcoin::parse_btc_call_envelope` (cxfer-core) parses the 201-byte envelope;
`cxfer_core::fold_btc_call` BIP-340-verifies the sig (`bip340_verify`) and returns `(call_id, record_hash)`
with `call_id = keccak(caller_pubkey ‖ call_nonce)` and `record_hash = keccak(executor ‖ target ‖
calldata_hash ‖ caller_pubkey)`. `reflect.rs` folds it beside `fold_cbtc_lock` and pushes the pair into a flat
`bytes32[] btcCallsFolded` (alternating callId, recordHash) on the relay public values. A bad/absent sig folds
nothing (skip-not-panic). It folds a **fact**, not an effect — no note, no mint, no value. (KAT
`btc_call_envelope_folds_and_binds`.)

**Contract — record-then-execute (the load-bearing decoupling), as built:**
- `attestBitcoinStateProven` records each pair into `mapping(bytes32 => bytes32) public pendingBtcCall`
  (`pendingBtcCall[callId] = recordHash`) — a single 32-byte commitment per call, the minimal pool footprint
  (≈130 B after a flat-array encoding; a struct array cost ~500 B). It **does not call out**, so a hostile
  target can never revert the reflection attest (the bridge's liveness-critical advance).
- A separate `BtcCallExecutor` contract (not the pool — least privilege + liveness) exposes permissionless
  `executeBtcCall(bytes32 callId, address target, bytes32 callerPubkey, bytes data)`, `nonReentrant`: reads
  `recordHash = POOL.pendingBtcCall(callId)` (revert if 0), requires `!fired[callId]`, and checks
  `keccak(abi.encodePacked(address(this), target, keccak(data), callerPubkey)) == recordHash` — one check
  binds the **executor** (`address(this)`, so a call recorded for another deployment's executor reverts), the
  target, the caller, AND the calldata (its hash is the Bitcoin-committed `calldata_hash`). Marks fired (CEI),
  then `IBitcoinHook(target).onBitcoinReflect(data, 0, callerPubkey)`. A revert fails **only this tx** and
  rolls the fired flag back, so the call stays re-executable.

**Why decoupled here but inline in Mode A:** Mode A's caller brings their own value and wants the mint + call
atomic, bearing any revert (exactly like a CDP controller). Mode B is permissionless infrastructure recorded
by the *shared* reflection — firing inline would let any griefer's call block the bridge, so it is recorded by
attest and fired by a separate tx. Liveness of the core is never coupled to an arbitrary callee.

**Caller identity:** `caller_pubkey` lets a target gate on the Bitcoin signer. A privacy-preserving variant
surfaces the blinded commit `caller_pubkey + b·G` (the protocol-wide pubkey-privacy primitive,
`SPEC-BLINDED-PUBKEY-AMENDMENT`) instead of the raw key — a target still recognizes a stable *shielded* caller
across calls without learning the Bitcoin key; additive.

**Value:** `value = 0`, fixed selector, `derive(target)` mint-bound — a Mode-B call moves no pool assets. To
move value on Ethereum it either rides a Mode-A `bridge_mint` or releases funds the caller pre-staged on
Ethereum (e.g. a contract the Bitcoin call unlocks).

## 2. Why this adds no real blast radius
Identical to the analysis for the `ICdpController` callback this mirrors — the pool already makes external
calls mid-settle (withdrawal transfers, `onCdp*`, engine reads):
- **Reentrancy globally locked.** `ReentrancyGuardTransient` = one transient slot across **all**
  `nonReentrant` entrypoints (`settle`/`attest`/`wrap`/`swap`/every liquidity op), and the callback fires
  after CEI — it cannot re-enter any state-mutating path.
- **Fixed call selector.** The pool invokes **only** `onBitcoinReflect(bytes,uint256,bytes32)`; the
  relayer-supplied `hookData` is an *argument*, never a raw call. An arbitrary `target` therefore cannot
  make the pool hit a privileged selector (a canonical-ERC20 `mint`, `CanonicalAssetFactory.deploy`) on a
  contract that trusts the pool as caller. This is what makes an attacker-chosen target safe.
- **Bounded authority.** The hook moves no pool assets; any minting it does is `derive(target)`-bound
  (`:1669`), so a rogue target can only inflate its own worthless-unless-backed token. Conservation +
  membership stay proof-enforced in the immutable core.
- **Residual = liveness only.** A reverting / gas-heavy hook reverts the batch that bundles it — a relayer
  batching concern (don't co-bundle unknown hooks), the same as a reverting CDP controller today. No
  fund-safety surface beyond the existing callback seam.
- **Mode B never couples the core's liveness.** Because Mode B records in attest and fires in a separate
  `executeBtcCall`, a hostile/gas-bomb target can revert only its own `executeBtcCall` — never the
  reflection attest (the bridge advance) and never another caller's call. The permissionless, value-free,
  shared-reflection surface is exactly why Mode B must not fire inline.

> Implementation invariant (load-bearing): the dispatch MUST stay `target.onBitcoinReflect(...)` and never
> become a raw `target.call(hookData)` — a raw call reopens exactly the privileged-caller surface the fixed
> selector closes. Worth a comment at the call site.

## 3. Privacy boundary
Same as `bridge_mint` + CDP: the burned-note owner and the minted-note owner stay **confidential**; the
hook's `value` is **public** (boundary-public, like CDP amounts). So the claim is *shielded-ownership,
value-bound* Bitcoin-triggered execution — not amount-private execution. (Amount-privacy here inherits the
same solvency/oracle-coupling trade documented for CDPs in `DESIGN-confidential-defi-v1.md` §10.)

## 4. What it unlocks
- **Mode A:** a Bitcoin burn is an authenticated trigger for an arbitrary Ethereum action, atomically with
  the bridged value — pay/settle an Ethereum obligation, fund a contract, or open a position in **one**
  Bitcoin-authorized step (today: a `bridge_mint` then a second settle). First reference consumer to
  exercise the interface: a `bridge_mint` that atomically opens a CDP (Bitcoin burn → debt position).
- **Mode B:** **any BTC holder programs Ethereum by signing a Bitcoin tx** — no Tacit asset, no bridge.
  Authorize a claim, cast a vote, release pre-staged Ethereum funds, kick a keeper, settle an off-chain
  obligation. This is the form that makes "Ethereum is Bitcoin's programmable layer" literally true for the
  whole BTC userbase, not just Tacit-note holders.

New consumers in either mode ship as **just a new hook contract** on the frozen core.

## 5. Trust ledger
| Concern | Mechanism | Trust |
|---|---|---|
| burn really happened (A) | relay-attested bridge-burn membership (unchanged `bridge_mint`) | **none** (proof) |
| value conserved + opened (A) | `v_mint == v_burn` kernel + value opening | **none** (proof) |
| call really came from Bitcoin (B) | reflection: txid-merkle + relay anchor + `REFLECTION_CONFIRMATIONS` | **none** (proof) |
| caller authorized this exact call (B) | Schnorr `sig` by `caller_pubkey` over the chain-bound message | **none** (proof) |
| call is the one authorized | `keccak(data) == calldata_hash` (Bitcoin-committed) | **none** (proof + on-chain check) |
| fires once | `bridgeMinted[ν]` (A) / `btcCallFired[call_id]` (B) | **none** (proof/contract) |
| callee can't touch other assets | fixed selector + `derive(target)` mint rule + conservation | **none** (proof/contract) |
| core liveness vs. hostile callee (B) | record-in-attest, fire-in-`executeBtcCall` (decoupled) | **none** (contract) |
| callee logic correctness | arbitrary mutable contract | **its own holders only** (bounded) |
| reentrancy / ordering | global transient guard + CEI (call last) | **none** (contract) |

## 6. Codesize — the gating prerequisite
`ConfidentialPool` deployed bytecode is **24550 / 24576 B (26 B headroom)** as of 2026-06-20. Both modes add
contract code over 26 B, so a reclamation pass is the first build gate either way
(`project_confidential_pool_codesize` playbook: remove whole functions, don't refactor internals; via_ir
non-monotonic):
- **Mode A:** `IBitcoinHook` (≈free), a `BtcHook` PV field (decode code), the `hookData` arg, the guarded
  end-of-`_settle` loop.
- **Mode B:** adds the `BtcCall` PV field + the attest record loop (mirrors `cbtcLocksFolded`, cheap), the
  `pendingBtcCall` mapping, and the small `executeBtcCall` function.

Modes are independent — Mode A can ship first (smaller delta) and Mode B follow, or both together after one
reclamation. Apply, measure, reclaim the overflow.

## 7. Build plan + the re-prove gate
1. **Guest** — Mode A: the optional hook read in `OP_BRIDGE_MINT` + the `btc_hooks` PV accumulator. Mode B:
   `parse_btc_call_envelope` + Schnorr verify + the `btcCallsFolded` accumulator in `reflect.rs`. KATs for
   each (a hooked burn / a signed call envelope → expected PV). The other 19 ops + plain bridge_mint
   unchanged; the reflection's existing folds unchanged.
2. **Contract** — Mode A: `IBitcoinHook`, the `BtcHook[]` PV field, the `hookData` arg, the
   end-of-`_settle` guarded loop. Mode B: the `BtcCall[]` PV field + attest record loop, `pendingBtcCall`,
   `btcCallFired`, `executeBtcCall`. **Then measure codesize and reclaim** (§6).
3. **JS mirror** — `confidential-pool.js` bridge-mint builder emits the optional hook envelope + carries
   `hookData` (A); a `btc-call` tx-builder emits the `0x68` `OP_RETURN` envelope + Schnorr sig (B);
   reflect-exec DIGEST_MATCH stays green.
4. **One reference consumer per mode** — A: Bitcoin-burn → CDP open. B: a value-free "release pre-staged
   Ethereum funds on a signed Bitcoin call" demo — to exercise each interface before it freezes.
5. **Box re-prove** — fold into a re-prove **after** the pending critical fixes (adaptor asset-binding,
   reflection witness-commitment) are frozen and steps 1–4 are green; not into the critical-fix re-prove
   itself (don't expand its diff). Mode A rotates `PROGRAM_VKEY`; Mode B rotates `BITCOIN_RELAY_VKEY`
   (reflection guest). Pin → deploy.

Steps 1–4 are fully local + testable (box-free). Step 5 is the irreversible gate.
