# TAC airdrop

The Ethereum-side distribution for the confidential pool and the formal v1 launch, separate from the earlier Bitcoin-side airdrop
(see [`airdrop/README.md`](../airdrop/README.md)). A one-shot merkle distributor for the public TAC ERC20. One funded pool of TAC, one merkle root, one claim per
recipient. A recipient can take the TAC as a normal ERC20, send it to another address, or shield it into the
confidential pool in the same transaction.

Contract: [`contracts/src/TacAirdrop.sol`](../contracts/src/TacAirdrop.sol). Tree tooling:
[`tools/airdrop-tree.mjs`](../tools/airdrop-tree.mjs), [`tools/airdrop-verify.mjs`](../tools/airdrop-verify.mjs).
Nothing here is deployed yet; the deployed address and root will be added to this page and to
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md) once they exist.

## 1. Who can do what

Everything that defines the airdrop is fixed at deployment and cannot be changed: the token, the merkle root, the claim
deadline, the guardian, the pool and the pool asset id. There is no owner, no proxy and no upgrade path.

| Actor | Can | Cannot |
| --- | --- | --- |
| Anyone | Submit `claim` for any recipient; the TAC always goes to the recipient's own address. Read every view. | Redirect a claim, claim twice, claim after the deadline. |
| A recipient | `claim`, `claimTo` (send to another address), `claimAndShield` (deposit into the confidential pool). Each leaf once. | Claim more or less than the leaf amount. |
| Guardian: the ops multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` | `pause` / `unpause` claims. `sweep(to, amount)`: move any amount of TAC out, **at any time, before or after the deadline**. `sweepToken(token, to, amount)`: move any other token, or ETH with `token = 0x0`. | Change the root, token, deadline, guardian or pool. Claim on a recipient's behalf. Extend the deadline. |

The emergency sweep means recipients trust the multisig until the deadline: it can take the unclaimed balance at any
moment, and can pause claims for the whole window. That is deliberate. It is the recovery route if the contract, the tree
or the funding turns out to be wrong, and it is also how the remainder is collected after the deadline. A claim that fails
reverts as a whole and leaves the leaf claimable. A guardian sweep does remove the unclaimed balance, and a sweep or a pause
can be undone only by the guardian, which can top the contract up again by transferring TAC in.

The guardian is the ops multisig at the address recorded as `engineAdmin` in
[`contracts/deployments/1.json`](../contracts/deployments/1.json). Confirm it with `node tools/verify-roles.mjs`, and
copy it from that file rather than retyping it (see the runbook).

## 2. Claim paths

All three share the same checks, in this order: not paused, at or before the deadline, leaf not already claimed, proof valid
against the root. The claimed bit is set before any tokens move, and a failed transfer reverts the whole call, bit included.

| Function | Caller | Result |
| --- | --- | --- |
| `claim(index, account, amount, proof)` | anyone | `amount` TAC to `account`. |
| `claimTo(index, amount, proof, to)` | must be the eligible account | `amount` TAC to `to`. `to` may not be zero, the airdrop contract or the TAC token itself. |
| `claimAndShield(index, amount, proof, commit)` | must be the eligible account | The whole amount is deposited into the confidential pool as a wrap deposit under `commit`. |

Views: `isClaimed(index)`, `verify(index, account, amount, proof)` (proof check only), `paused()`, and the immutables
`TOKEN`, `MERKLE_ROOT`, `GUARDIAN`, `CLAIM_DEADLINE`, `POOL`, `ASSET_ID`, `UNIT_SCALE`.

`CLAIM_DEADLINE` is the last second at which a claim is accepted; from the next second on every claim path reverts.

### Shielding a claim

`claimAndShield` calls the pool's `wrap` for TAC with the caller's `commit`. TAC is a pool-minted asset, so the pool burns
the TAC directly from the airdrop contract's balance; no allowance is ever granted or left behind. The deposit is registered
under `commit` exactly as if the recipient had called `wrap` themselves.

Build the commit from the recipient's Tacit wallet key with the same call the dapp uses for any wrap:

```js
const idx = await tacit.nextWrapIndex({ walletPriv, ticker: 'TAC' });
const w   = tacit.buildWrap({ walletPriv, amountWei: leaf.amount, ticker: 'TAC', index: idx });
// send from the eligible account:  claimAndShield(leaf.index, leaf.amount, leaf.proof, w.commit)
// then settle the deposit into a note:  tacit.submitWrapSettle({ built: w })
```

The transaction is signed by the eligible account (any wallet); the note key is the Tacit wallet key and can be a different
one. The note is recovered from the wallet key alone: the wrap walk matches the deposit ids the key derives to the pool's public
`Wrap` events, whoever the depositor was.

Rules that keep this safe:

- The amount must be a multiple of the pool unit scale for TAC (`1e10` wei, one 8-decimal unit). A leaf carrying sub-unit
  dust reverts here with `AmountNotAligned`, and stays claimable through `claim` or `claimTo`, so dust cannot strand. The tree
  tool refuses such amounts up front, so this only matters for a hand-made tree.
- A zero `commit` reverts. Any other commit is the caller's responsibility, as with `wrap`: a commit not derived from a key the
  caller holds makes an unspendable deposit. Use `buildWrap`.
- If the pool reverts for any reason, including a deposit id that already exists (same asset, value and commit), the whole call
  reverts and the leaf is unclaimed. Use a fresh wrap index and retry.
- **The pool has no cancel or refund for a pending deposit.** A deposit is cleared only by a proof that consumes it, and that
  proof needs only the note secrets, not the depositor. So the airdrop contract, as depositor, is never owed anything back, and
  there is nothing for it to strand. The only way to lose a shielded claim is to lose the wallet key that derived its commit.
- Anyone can submit `claim` for a recipient, using the public proof file. If a third party does that before a
  `claimAndShield`, the recipient receives plain TAC at their own address and the shield attempt reverts as already claimed.
  No value is lost; the recipient can shield it themselves with an ordinary wrap. There is no on-chain way to prevent this
  (the proofs are public by design), so a claim UI should say so and treat "already claimed" as a delivery to the recipient's
  own address.

## 3. Verifying the root and the code

Before funding, and again for anyone who wants to check:

1. **The tree.** Regenerate it from the published recipient list and compare the root. That is the completeness check: it shows
   the root commits to the listed recipients and nothing else. Anyone can also recheck a published proofs file:

   ```sh
   node tools/airdrop-tree.mjs --verify-file proofs.json --root <root>
   ```

   This recomputes every proof, the index order, every amount and the total, and rebuilds the whole tree from the listed claims
   to require the same root, so a root that also commits to unlisted leaves is rejected. The multisig signers should still rebuild
   the root from the recipient list themselves before funding.
2. **The contract.** On the deployed address:

   ```sh
   cast call $AIRDROP 'MERKLE_ROOT()(bytes32)'
   cast call $AIRDROP 'TOKEN()(address)'      # the public TAC token in deployments/1.json
   cast call $AIRDROP 'GUARDIAN()(address)'   # the ops multisig
   cast call $AIRDROP 'CLAIM_DEADLINE()(uint64)'
   cast call $AIRDROP 'POOL()(address)'; cast call $AIRDROP 'ASSET_ID()(bytes32)'
   ```

3. **One recipient.** `airdrop-verify` reads the proof, checks it locally, then asks the contract to verify it and reports whether the
   leaf is still claimable. It sends nothing:

   ```sh
   node tools/airdrop-verify.mjs --contract $AIRDROP --address 0x... --proofs proofs.json --root <root> [--rpc <url>]
   ```

   `--proofs` also accepts a directory or an http(s) base URL of per-recipient files (`<base>/<address>.json`). On chain 1 it
   also checks the guardian, token and pool against `contracts/deployments/1.json`.
4. **The source.** Once deployed, the contract is verified on Etherscan from `contracts/src/TacAirdrop.sol` with the repo's Foundry profile (the
   `solc` version is the pragma in the file). Its dependencies are two Solady libraries already used elsewhere in this repo.

## 4. Building the tree

Input is a list of addresses and amounts, JSON (`[{ "address": "0x..", "amount": "12.5" }]`) or CSV (`address,amount`,
header optional). `amount` is whole TAC by default (up to 18 decimals); `--unit wei` reads base units.

```sh
node tools/airdrop-tree.mjs --input recipients.csv --expect-total 1000000 \
  --out proofs.json --out-dir proofs/
```

- `--expect-total` is required and must equal the funding exactly (in TAC, or in wei with `--unit wei`).
- Rejected before any root is produced, all problems listed together: a malformed address (a mixed-case address must carry a valid
  checksum), the zero address, a duplicate in any letter case, the TAC token or pool address (add more with `--reserve`, for
  instance the airdrop's own address once known), a zero amount, an amount that is not a multiple of `1e10` wei, a pool value
  above `u64`, and a total that differs from `--expect-total`.
- Index assignment is deterministic: addresses sorted ascending, index = position. The root does not depend on input order.
- Every proof is recomputed against the root before the files are written.
- `proofs.json` is one file keyed by lowercase address. For a large list use `--out-dir`, which writes
  `<dir>/<address>.json` per recipient plus `manifest.json` (`root`, `count`, `totalWei`), so a static host serves one small
  file per lookup. A 100,000-recipient tree is about 150 MB as a single file.
- Leaf: `keccak256(keccak256(abi.encode(index, account, amount)))`. Node: keccak of the sorted pair.
- The Solidity tests read proof files this tool wrote (`contracts/test/fixtures/airdrop/`, regenerated with `node
  contracts/test/fixtures/airdrop/generate.mjs`) and check them against the contract's verifier and claim paths, so the two
  implementations are pinned to each other.

## 5. Runbook for the ops multisig

**Inputs to decide and freeze**

| Input | Value |
| --- | --- |
| Recipient list and amounts | owner decision; total exactly the funding (1,000,000 TAC) |
| `--expect-total` | the same number |
| Claim deadline | owner decision (unix seconds, must be in the future at deploy) |
| `token` | `tacToken` in `contracts/deployments/1.json` |
| `guardian` | `engineAdmin` in `contracts/deployments/1.json` (the ops multisig) |
| `pool` | `pool` in `contracts/deployments/1.json` |
| `assetId` | `tacAssetId` in `contracts/deployments/1.json` |
| `root` | printed by `airdrop-tree.mjs` |

The constructor refuses a token, pool or asset id that is not a registered pool-minted TAC asset, a guardian address that has no
code (a mistyped address, since the multisig is a contract), a zero root, and a deadline that is not in the future or is more than
400 days out (a timestamp in milliseconds is caught here). It cannot tell a wrong non-zero guardian that happens to be a contract,
so step 4 checks the guardian and deadline against the intended values before funding.

**Steps**

1. `node tools/verify-roles.mjs` is clean.
2. Build the tree (section 4), re-run `--verify-file`, and publish the recipient list so anyone can rebuild the root.
3. Deploy from any account (the deployer has no powers). Read the addresses from the manifest instead of typing them:

   ```sh
   cd contracts          # the Foundry profile (via_ir, optimizer, bytecode hash) lives here; the bytecode must match the verified source
   D=deployments/1.json
   forge create src/TacAirdrop.sol:TacAirdrop --rpc-url $RPC --account $DEPLOYER --broadcast \
     --constructor-args $(jq -r .tacToken $D) $ROOT $(jq -r .engineAdmin $D) $DEADLINE $(jq -r .pool $D) $(jq -r .tacAssetId $D)
   ```

4. Verify the source on Etherscan, run the on-chain checks in section 3, and run `airdrop-verify` for a few recipients, including
   the largest and the last index. Before funding, the guardian must equal `engineAdmin`, the deadline must be the intended date, and
   the root must equal the one printed by the tree tool; `airdrop-verify` fails any of those that does not hold.
5. **Fund once**: the multisig transfers exactly the tree total of TAC to the airdrop address. Then check
   `balanceOf(airdrop) == totalWei`. Do not announce before this holds. A short funding is not unsafe (a claim that cannot be paid
   reverts and leaves the leaf claimable, and topping up fixes it), but the last claimants would fail until it is.
6. Publish the proof files and the root, and add the address to `DEPLOYMENTS.md`.

TAC is minted by the pool when a shielded note is unwrapped, so funding does not depend on today's circulating supply. The
planned route is a relayed `sendUnwrap` of the shielded 1,000,000 TAC note straight to the airdrop address, sized so the fee
comes out of the change; the tree total is set to the amount unwrapped, and `balanceOf(airdrop)` is checked against it. The
multisig can equally fund from public TAC it already holds.

**During the window**

- `pause()` blocks every claim and moves nothing; `unpause()` reopens. Pausing does not extend the deadline, and unpausing after the
  deadline reopens nothing, so a pause held to the deadline denies every claim.
- `sweep(to, amount)` moves TAC out at any time. To abandon the airdrop, `pause()` first, then sweep the full balance. Claims made
  before the sweep stay paid.
- `sweepToken(token, to, amount)` recovers other tokens or ETH sent to the contract by mistake.

**At the deadline**

Claims revert from the second after `CLAIM_DEADLINE`. The guardian then calls `sweep(to, balance)` for the remainder. Unclaimed
allocations are not claimable after that unless the guardian funds a new airdrop.

**Gas** (mainnet fork, whole transaction including the 21,000 base, real TAC and pool, 1,024 leaves = 10 proof words)

| Path | First claim in a bitmap word | Later claim in the same word | Deploy |
| --- | --- | --- | --- |
| `claim` | 88.3k | 71.2k | 674k |
| `claimTo` | 88.1k | about 71k | |
| `claimAndShield` | 108.8k | 91.7k | |

A 100,000-leaf tree needs 16 or 17 proof words and adds about 4k gas per claim (claim 92.7k, `claimAndShield` 112.6k). A word
covers 256 indexes; the first claim in a word pays the 20k storage set.

## 6. Design note: claim and zap into the TAC/cETH farm

Status: design only, not built. The goal is one guided flow that takes an airdrop leaf to a bonded position in the TAC/cETH
farm (pid 0, LP-share asset in [`FARMS.md`](./FARMS.md) section 2) without an idle LP note.

**What must be contract-level, and what cannot be.** Only the deposit. `claimAndShield` already gives a TAC deposit under a
commit the wallet derived. Adding liquidity and bonding are proof-driven settles (`OP_WRAP_LP`, `OP_LP_BOND`, `OP_FARM_BOND`); a
contract cannot run them, and nothing in the airdrop contract can do the job of the relay or the prover. So no contract change
and no new op is needed, and the guest and vkeys stay untouched.

**Smallest correct flow, with the ops that exist today**

| # | Step | Kind | Proof? |
| --- | --- | --- | --- |
| 1 | `claimAndShield` with the commit from `buildWrap({ ticker: 'TAC', index })` | user tx, sent by the eligible account | no |
| 2 | deposit the cETH leg: the pool's or router's native-ETH wrap with the commit from `buildWrap({ ticker: 'cETH', index })` | user tx | no |
| 3 | `tacit.wrapLp(...)`: `OP_WRAP_LP` consumes both deposits directly and mints the LP-share note | one settle | 1 |
| 4 | `tacit.farmBond({ controller: farm.manager, lpNote })`: bonds that note in the FarmManager | one settle | 1 |

Two user transactions and two proofs. The two deposits never become tree notes on the way in, which is why this beats the
alternatives:

- Shield, `OP_WRAP` each deposit into a note, then `lpBond` (`OP_LP_BOND` spends two whole notes and bonds in one settle): three
  proofs.
- There is no op that consumes deposits and bonds in the same proof. Adding one is a guest change, hence a new vkey set, so it
  is out of scope here.

**What the user must also deposit.** The pair needs the cETH leg, in ratio with the pool reserves. The TAC side is the whole leaf
amount, fixed. Size the cETH deposit with `tacit.quoteLpAdd` (`q.amountB` rounds up) right before step 2. A TAC-only user would
need a swap first (`wrapSwap` consumes one deposit, then an add), which costs price impact and at least one more proof; do not offer
it as the default.

**Failure and refund behaviour**

- Step 1 fails atomically (bad proof, closed window, pool revert, colliding deposit id): the leaf stays unclaimed, no TAC moved.
- Steps 3 or 4 fail to prove or settle (reserves moved since the quote, deadline passed, relay unavailable): the deposits stay
  pending and unconsumed. There is no on-chain cancel, but each deposit can be consumed on its own with `submitWrapSettle` into an
  ordinary note, and then `lpBond` or `lpAdd` + `farmBond` finishes the job later. Nothing is lost; it is only slower.
- After a successful step 3 and before step 4 the user holds an LP-share note, recoverable from the memo scan. `farmBond` then bonds
  it; the position key re-derives from the wallet key, the manager, the LP asset and that note.

**Things that could strand or cost funds, and the guard for each**

1. *Ratio drift between the deposits and the settle.* Both deposits are fixed at deposit time, but `OP_WRAP_LP` derives shares from
   the live reserves and reverts if they moved. If the settle is rebuilt against new reserves, anything off the pool ratio is
   donated to existing LPs. The value is not stranded, but it is given away. Guard: quote just before step 2, settle immediately,
   and have the dapp refuse to settle when the implied donation exceeds a small tolerance, falling back to per-deposit `OP_WRAP`.
2. *Lost wallet key or a commit not derived from a held key.* The deposit cannot be consumed by anyone. Guard: derive every commit
   with `buildWrap` from the key in use, using `nextWrapIndex`, never a hand-written value, and persist nothing that the key cannot
   re-derive.
3. *Deposit id collision.* Reusing `(asset, value, commit)` reverts at the pool. Guard: a fresh index per deposit. The revert is
   atomic, so it strands nothing.
4. *Two different signers.* The leaf's account signs step 1; the wallet key signs the ops. If the account is not the wallet's
   derived EVM account, gas for the settles comes from wherever the flow sends them (`selfRelay` uses the derived account and needs
   ETH). Make that explicit in the UI.
5. *Relay fee leg.* `wrapLp` carves an optional fee from the A leg; `lpBond` has no fee leg and is self-settled. Whether the relay
   accepts a fee-less `farmBond` should be confirmed live before this is promised as fully relayed.
6. *Pool retirement.* A retired generation still accepts TAC deposits (the token is pool-minted), but the farm and the pair belong
   to the active generation. Do not run the flow against a generation that has a successor.

An airdrop leaf is all or nothing. A recipient who wants part in the farm and part elsewhere should claim in the clear and use
the ordinary wrap flows for each part.

## 7. Known properties

- The public proofs let anyone deliver a recipient's claim, always to the recipient (section 2).
- The guardian can sweep at any time (section 1). There is no on-chain timelock.
- A token or pool that behaves unlike TAC and the live pool is refused at deployment; the airdrop contract is only meant for this
  pair.
- Sending ETH to the contract reverts; ETH that arrives by other means can be swept with `sweepToken(0x0, ...)`.
