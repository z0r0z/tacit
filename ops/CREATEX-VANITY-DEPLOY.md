# CreateX CREATE3 cross-chain-identical vanity deployment (Tacit V1 suite)

Goal: every Tacit V1 contract gets a `0x00000000…` (4 leading zero bytes) address that is
**byte-for-byte identical on Sepolia, Ethereum mainnet, and the major L2s** (Arbitrum, Optimism,
Base, Polygon, …), even though each chain's constructor args differ (vkeys / admin multisig /
oracle feeds). This is achieved with CreateX CREATE3 + a portable (sender-agnostic,
chainid-agnostic) salt form.

## Why CREATE3 (and not CREATE2)

CREATE2 address = `f(deployer, salt, keccak256(initCode))`. Tacit's per-chain constructor args
differ ⇒ `initCode` differs per chain ⇒ CREATE2 address differs per chain. Useless here.

CREATE3 address = `f(deployer, salt)` ONLY — **independent of initCode**. CreateX's
`deployCreate3(salt, initCode)` deploys a tiny fixed proxy via CREATE2(guardedSalt), then the proxy
does a plain CREATE of `initCode` at nonce 1. The final child address depends only on the proxy
address (which depends only on `deployer` + `guardedSalt` + the fixed proxy bytecode), never on
`initCode`. So the SAME salt → the SAME address on every chain that has CreateX, regardless of the
constructor args. That is the entire mechanism.

CreateX canonical factory (same address on all major chains + testnets + L2s):

    0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed

## THE GOTCHA: CreateX salt-guarding (`_guard` / `_parseSalt`)

`deployCreate3(bytes32 salt, bytes initCode)` does NOT use the raw `salt` directly. It first runs
`salt` through `_guard(salt)` to produce `guardedSalt`, and the proxy's CREATE2 uses
`guardedSalt`. `_parseSalt` inspects the salt's first 21 bytes:

  - `salt[0:20]` ("SenderBytes"): equal to `msg.sender` → MsgSender; equal to zero → ZeroAddress;
    anything else → Random.
  - `salt[20]` ("RedeployProtectionFlag"): `0x01` → True; `0x00` → False; anything else → Unspecified.

`_guard` then maps `(SenderBytes, RedeployProtectionFlag)` to `guardedSalt`:

| (SenderBytes, Flag)        | guardedSalt                                              | portable? |
|----------------------------|----------------------------------------------------------|-----------|
| MsgSender, True            | `keccak256(abi.encode(msg.sender, block.chainid, salt))` | NO — sender + chainid mixed |
| MsgSender, False           | `_efficientHash(uint160(msg.sender), salt)`              | NO — sender mixed |
| MsgSender, Unspecified     | revert InvalidSalt                                       | — |
| ZeroAddress, True          | `_efficientHash(block.chainid, salt)`                    | NO — chainid mixed |
| ZeroAddress, Unspecified   | revert InvalidSalt                                       | — |
| **Random, any**            | **`keccak256(abi.encode(salt))`**                        | **YES** |
| **ZeroAddress, False**     | **`keccak256(abi.encode(salt))`**                        | **YES** |

(Random/ZeroAddress-False both hit the same final branch: `salt != _generateSalt() ?
keccak256(abi.encode(salt)) : salt`. `_generateSalt()` hashes 7 live values — `blockhash`,
`coinbase`, `block.number`, `timestamp`, `prevrandao`, `chainid`, `msg.sender` — so a precomputed
vanity salt has zero practical chance of equalling it; the branch always takes
`keccak256(abi.encode(salt))`.)

### Decision: use the **Random** salt form (portable)

We require: no `msg.sender` in `guardedSalt`, no `block.chainid` in `guardedSalt`. Only the
`Random` and `ZeroAddress+False` branches qualify, and both yield the identical, fully-portable

    guardedSalt = keccak256(abi.encode(salt))

We mine **Random** salts (the high bytes are free entropy from the miner — they are NOT a sender
address and NOT all-zero, so they parse as Random; we just keep `salt[20] != 0x01` to avoid any
redeploy-protection branch, e.g. leave it `0x00`). This guards to `keccak256(abi.encode(salt))` on
every chain ⇒ identical proxy ⇒ identical CREATE3 child address everywhere. Anyone may call
`deployCreate3` with our salt (permissionless), which is fine: the address is fixed by the salt,
and our constructor args (admin/feeds) are baked into each chain's initCode at deploy time, not
into the address.

## Precompute (knowing the address before you deploy)

CRITICAL asymmetry, confirmed from source:

  - `deployCreate3(bytes32 salt, …)` applies `_guard(salt)` internally.
  - `computeCreate3Address(bytes32 salt)` does **NOT** apply `_guard` — it treats its argument as
    the already-guarded salt and derives the proxy/child directly.

Therefore to predict where `deployCreate3(rawSalt, …)` lands you must pass the GUARDED salt:

    predicted = ICreateX(CREATEX).computeCreate3Address( keccak256(abi.encode(rawSalt)) )

`DeployV1SuiteCreateX.s.sol` does exactly this: for each contract it computes the guarded salt,
asks CreateX for the address via `computeCreate3Address`, wires those precomputed addresses into
the downstream constructor args (CREATE3 removes deploy-ordering deps — the pool's address is known
before the engine is deployed and vice-versa), then deploys each contract with
`deployCreate3(rawSalt, initCode)`. The engine↔pool circular-immutable problem the legacy script
solved with a setPool-then-handoff dance is now moot for ADDRESS purposes (both addresses are known
up front); we still honor the engine's one-shot `setPool` + ownership-handoff ordering because
those are STATE wiring, not address wiring.

## The miner: createXcrunch (NOT plain create2crunch)

`create2crunch` mines plain CREATE2 (`f(deployer, salt, keccak256(initCode))`) — WRONG here,
because (a) it bakes in initCode and (b) it does not model CreateX's proxy hop or the
`keccak256(abi.encode(salt))` guard. Use **createXcrunch**
(https://github.com/HrikB/createXcrunch), the CreateX-aware fork: it models
`rawSalt → guardedSalt=keccak256(abi.encode(rawSalt)) → CREATE2 proxy → CREATE3 child` and mines
`rawSalt`s whose final child address matches the pattern. Feed those raw salts straight into the
script.

See `tools/mine-vanity-salts.sh` for the exact invocation (GPU box 40707240) and the salt→script
handoff.
