# Verify the live deployment

`tools/verify-live.mjs` checks the mainnet deployment against what this repository claims about it, and prints
a pass/fail table. It is read-only: it broadcasts nothing, signs nothing, and takes no key, token or
configuration. Anyone can run it, and it exits non-zero if any check fails.

```sh
npm install                      # @noble/hashes, for keccak and sha256
cd contracts && forge build      # produces the artifacts the bytecode checks compare against
cd .. && node tools/verify-live.mjs
```

It reads Ethereum over public RPC, trying `ethereum-rpc.publicnode.com`, `eth.drpc.org`, `cloudflare-eth.com`
and `1rpc.io/eth` in turn, and pins every read to one block so the table is a single coherent snapshot. About
fifty calls, a few seconds.

## What it checks

**Deployed code is the code in this checkout.** It fetches the pool's runtime bytecode and compares it, byte
for byte, with the artifact `forge build` produces here. Two kinds of slot are chosen at deploy time rather
than at compile time and are normalised away before the comparison: the twelve `ReflectionLib` link offsets
from [`contracts/pool-bytecode-pin.json`](../contracts/pool-bytecode-pin.json), and the immutable slots from
the artifact's own `deployedBytecode.immutableReferences`. It separately checks that all twelve link sites name
the *same* library, fetches that library, and confirms it matches its own compiled artifact except for the
self-address baked into it — which must equal the address it is deployed at. The keccak of the
link-normalised local artifact is checked against `runtime_keccak` in the bytecode pin, which is the same
identity `contracts/verify-pool-size.sh` asserts in CI.

**The deployed verifying keys are the pinned ones.** `PROGRAM_VKEY` and `BITCOIN_RELAY_VKEY` are
`internal immutable`: there is no getter, and `cast call PROGRAM_VKEY()` reverts. They are compiled into the
runtime as `PUSH32` operands, so the script reads them out of the bytecode at their immutable offsets and
compares them with [`contracts/sp1/confidential/elf-vkey-pin.json`](../contracts/sp1/confidential/elf-vkey-pin.json).
It also hashes the three committed guest ELFs and checks them against the same pin.

**The immutable wiring matches the deployment manifest.** SP1 verifier, header relay, collateral engine,
public AMM, canonical factory, tETH link id, lineage steward, reflection confirmations and predecessor, all
read from the bytecode and compared with [`contracts/deployments/1.json`](../contracts/deployments/1.json),
plus a code-size check on each address so none of them is an empty account. `CHAIN_BINDING` is re-derived as
`keccak256(abi.encodePacked(uint256(chainId), pool))` and compared with the baked value. The pool's
`COLLATERAL_ENGINE()` getter and the engine's `POOL()` are read too: they close the wiring loop in both
directions, and the getter is what proves the script has the immutable slots labelled correctly.

**The protocol is live and moving.** The header relay's tip height, the Bitcoin block the pool has attested
to, the distance between them against the pool's confirmation depth, the attested reflection digest and
counters, the note tree's root and leaf count, `cbtcBackingSats`, and whether a successor pool has been
named. The engine's oracle reads (`btcToUsd`, `wstEthForBtc`, `requiredEscrow`) are quoted per whole BTC; they
revert on a stale feed, so a number coming back at all is the freshness check, and `requiredEscrow` is checked
to be exactly `escrowRatioBps` applied to the mark.

**Solvency at the public boundary.** The pool's ETH, USDC, USDT and wstETH balances, the wstETH the engine
holds as cBTC escrow, and the one invariant that is actually checkable from outside: a canonical token
(`tacBTC`, `tacUSD`) only exists because the pool burned an in-system note to mint it, so its ERC-20 supply
must not exceed what the pool tracks as backing that asset.

It reports the escrow the engine holds and, separately, what today's mark would require if every tracked sat
had minted — and deliberately does **not** divide one by the other. `cbtcBackingSats` counts every lock
reflection has recorded, including locks that never cleared the escrow gate and so minted nothing; escrow is
posted per position at mint time, and a lock that minted nothing requires none. Dividing therefore understates
coverage by the share of tracked sats that never minted, which on this deployment is half of them. A real
coverage figure needs the per-lock `cbtcLockVBtc` and `cbtcMinted` split, and the pool emits no event carrying
it, so an outside reader has to walk the attest calldata for the outpoints — out of scope for a snapshot this
size, and better absent than wrong.

**Risk parameters, printed plainly.** `cdpRatioBps`, `liqRatioBps`, `escrowRatioBps`, `maxStaleness`,
`maxDeviationBps`, `stabilityFeePerSecond`, `escrowMaintenanceBps`, `insuranceReserve`, `outstandingCusd`,
`escrowGraceWindow` and the configured feeds. Combinations worth a reader's attention — an empty insurance
reserve against live debt, a dormant escrow margin call, a single-source oracle, a disabled deviation bound —
are printed as `note` rows. They are neither failures nor endorsements; the script has no standing to decide
the protocol's risk appetite, only to make the setting visible.

## What it does not prove

- **Not that a guest ELF derives its pinned verifying key.** The script proves the deployed immutable equals
  the pinned key, and that the committed ELF bytes equal the pinned hash. It does not derive a key from an
  ELF — that needs the SP1 toolchain. The binding is enforced at prove time by the `EXPECT_VKEY` guard in the
  prove harnesses, and at deploy time by `DeployConfidentialPool`'s `require`. To reproduce it yourself,
  follow [`REPRODUCIBLE-BUILDS.md`](./REPRODUCIBLE-BUILDS.md), which rebuilds each ELF byte for byte and
  re-derives its key.
- **Not that the source is correct.** It proves the deployed runtime is what *this source tree* compiles to
  under the pinned compiler settings. Whether that source is sound is an audit question
  ([`audit/AUDITS.md`](../audit/AUDITS.md)), and whether the compiler is honest is a compiler question.
- **Not that off-chain services are honest.** Relay, prover, hosted API and IPFS gateways are not contacted.
  A service that has stalled, or that is serving something it should not, is invisible here unless it has
  already written inconsistent state on chain. In particular a reflection lane can be stalled while every
  check on this page passes, because a stalled lane simply stops advancing rather than becoming inconsistent.
- **Not anything about Bitcoin.** No Bitcoin node is queried. `relay.tipHeight` is what the header relay
  contract believes, not what Bitcoin's chain tip is; the relay trails live Bitcoin by design, so this number
  being behind is not by itself a fault.
- **Not the hidden state.** Note amounts, ownership and the shielded supply of escrow-wrapped assets are
  private by construction. The solvency section therefore prints the pool's ERC-20 and ETH balances without
  asserting an invariant over them: the in-system supply they back is not public. Only the pool-minted
  canonical tokens admit a public bound, and those are the two that are checked.
- **Not that the manifest is right.** `contracts/deployments/1.json` is repository data. Checks compare chain
  state against it, so a wrong manifest agreeing with a wrong deployment would pass. The pool address is the
  anchor; confirm it independently before trusting the rest.
- **Not that the RPC is telling the truth.** It trusts whichever public endpoint answers. Re-run it against a
  different endpoint, or your own node, if that matters to you.

A green run means: the bytecode on mainnet is this repository's bytecode, it is wired to the addresses and
keys this repository publishes, and the state it is in is internally consistent right now. That is the whole
claim.
