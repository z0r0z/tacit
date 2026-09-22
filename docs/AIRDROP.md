# TAC airdrop

A one-shot merkle distributor for the public TAC ERC20 on Ethereum: one funded balance, one root, one claim per
recipient. A recipient takes the TAC as a normal ERC20, sends it to another address, or shields it into the
confidential pool in the same transaction. It is separate from the Bitcoin-side distribution in
[`airdrop/README.md`](../airdrop/README.md).

| | |
| --- | --- |
| Contract | `0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8` ([`contracts/src/TacAirdrop.sol`](../contracts/src/TacAirdrop.sol), verified on Etherscan); root, deadline and guardian in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md#tac-airdrop-merkle-distributor) |
| Inputs and how to rebuild the root | [`airdrop/v1/README.md`](../airdrop/v1/README.md) |
| Tree tooling | [`tools/airdrop-tree.mjs`](../tools/airdrop-tree.mjs), [`tools/airdrop-verify.mjs`](../tools/airdrop-verify.mjs) |
| Proofs | `dapp/airdrop/v1/proofs`, served at `https://tacit.finance/airdrop/v1/proofs/<xx>.json` (`xx` is the first byte of the lowercase address). tacit.finance sends no CORS header; other origins use the commit-pinned copies listed in [`airdrop/v1/README.md`](../airdrop/v1/README.md#claim-proofs) |
| Client | [`dapp/tac-airdrop.js`](../dapp/tac-airdrop.js) (`tacit.tacAirdrop` on the pool ux): reads an allocation, checks it against the root, reads the contract and builds the claim calls |
| Integrator guides | [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md#5a-tac-airdrop) section 5a (with a no-dependency read-only snippet), [`INTEGRATOR-PLAYBOOK.md`](./INTEGRATOR-PLAYBOOK.md#3b-the-tac-airdrop) section 3b |

## 1. Who can do what

Everything that defines the airdrop is fixed at deployment and cannot be changed: the token, the merkle root, the claim
deadline, the guardian, the pool and the pool asset id. There is no owner, no proxy and no upgrade path.

| Actor | Can | Cannot |
| --- | --- | --- |
| Anyone | Submit `claim` for any recipient; the TAC always goes to the recipient's own address. Read every view. | Redirect a claim, claim twice, claim after the deadline. |
| A recipient | `claim`, `claimTo` (send to another address), `claimAndShield` (deposit into the confidential pool). Each leaf once. | Claim more or less than the leaf amount. |
| Guardian: the ops multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` | `pause` / `unpause` claims. `sweep(to, amount)`: move any amount of TAC out, **at any time, before or after the deadline**, subject to the multisig's own delay described below. `sweepToken(token, to, amount)`: move any other token, or ETH with `token = 0x0`. | Change the root, token, deadline, guardian or pool. Claim on a recipient's behalf. Extend the deadline. |

The sweep means recipients trust the multisig until the deadline: it can take the unclaimed balance at any moment,
and can pause claims for the whole window. It is the recovery route if the contract, the tree or the funding is wrong,
and it is how the remainder is collected after the deadline. A claim that fails reverts as a whole and leaves the leaf
claimable. Only the guardian can undo a sweep or a pause; it can top the contract up again by transferring TAC in.

The guardian is the ops multisig at the address recorded as `engineAdmin` in
[`contracts/deployments/1.json`](../contracts/deployments/1.json). Confirm it with `node tools/verify-roles.mjs`, and
copy it from that file rather than retyping it (see the runbook).

The multisig is two-of-four with a built-in one-hour delay ([SPEC §7.2](../SPEC.md#72-governed-periphery)): two
owner signatures queue a call, anyone can execute it after the delay, and a call signed by all four owners runs
immediately. A pause or a sweep therefore takes at least an hour on the standard path, and the queued call is
visible on-chain for that hour. The guardian is fixed at deployment: with fewer than two owner keys available there
is no pause and no sweep, and claims still work.

## 2. Claim paths

All three share the same checks, in this order: not paused, at or before the deadline, leaf not already claimed, proof valid
against the root. The claimed bit is set before any tokens move, and a failed transfer reverts the whole call, bit included.

| Function | Caller | Result |
| --- | --- | --- |
| `claim(index, account, amount, proof)` | anyone | `amount` TAC to `account`. |
| `claimTo(index, amount, proof, to)` | must be the eligible account | `amount` TAC to `to`. `to` may not be zero, the airdrop contract, the TAC token or the confidential pool. |
| `claimAndShield(index, amount, proof, commit)` | must be the eligible account | The whole amount is deposited into the confidential pool as a wrap deposit under `commit`. |

Settling a shielded deposit into a spendable note needs a proof, and that step has not been run on mainnet for this
contract. Offer `claim` and `claimTo` first, and treat the shield option as unproven.

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

`tacit.tacAirdrop.shieldPlan({ walletPriv, address, allowUnproven: true })` does this for the dapp: it reads the status, takes the next unused wrap index, builds the wrap for
TAC, checks that the wrap's asset and the ux's pool are the ones the airdrop deposits into, and returns the transaction with a record that holds no secret.
`claimAndShield(plan, { send })` sends it from the recipient's account, and `settleShield({ walletPriv, record })` settles the deposit once the pool reports it pending
(`depositStatus`). `shieldPlan` refuses without `allowUnproven: true`.

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

Anyone can check the deployment:

1. **The tree.** Regenerate it from the published recipient list and compare the root. That is the completeness check: it shows
   the root commits to the listed recipients and nothing else. Anyone can also recheck a published proofs file:

   ```sh
   node tools/airdrop-tree.mjs --verify-file proofs.json --root <root>
   ```

   This recomputes every proof, the index order, every amount and the total, and rebuilds the whole tree from the listed claims
   to require the same root, so a root that also commits to unlisted leaves is rejected.
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

   The client does the same checks in a page (local proof recomputation, then the contract's own `verify`). `--proofs` also accepts a directory or an http(s) base URL holding per-recipient files (`<base>/<address>.json`) or shards by leading address
   byte (`<base>/<xx>.json`, as in `dapp/airdrop/v1/proofs`, published at `https://tacit.finance/airdrop/v1/proofs`). On chain 1 it
   also checks the guardian, token and pool against `contracts/deployments/1.json`.
4. **The source.** The contract is verified on Etherscan from `contracts/src/TacAirdrop.sol` with the repo's Foundry profile (the
   `solc` version is the pragma in the file). Its dependencies are two Solady libraries used elsewhere in this repo.

## 4. Building the tree

Input is a list of addresses and amounts, JSON (`[{ "address": "0x..", "amount": "12.5" }]`) or CSV (`address,amount`,
header optional). `amount` is whole TAC by default (up to 18 decimals); `--unit wei` reads base units.

```sh
node tools/airdrop-tree.mjs --input recipients.csv --expect-total 1000000 \
  --out proofs.json --out-dir proofs/
```

- `--expect-total` is required and must equal the funding exactly (in TAC, or in wei with `--unit wei`).
- Rejected before any root is produced, all problems listed together: a malformed address (a mixed-case address must carry a valid
  checksum), the zero address, a duplicate in any letter case, any protocol contract, token, pool, ops multisig or burn address
  (every address in the deployment manifest is reserved automatically; add more with `--reserve`, for instance the airdrop's
  own address once known), a zero amount, an amount that is not a multiple of `1e10` wei, a pool value above `u64`, and a total
  that differs from `--expect-total`.
- Index assignment is deterministic: addresses sorted ascending, index = position. The root does not depend on input order.
- Every proof is recomputed against the root before the files are written.
- `proofs.json` is one file keyed by lowercase address. For a large list use `--out-dir`, which writes
  `<dir>/<address>.json` per recipient plus `manifest.json` (`root`, `count`, `totalWei`), so a static host serves one small
  file per lookup. A 100,000-recipient tree is about 150 MB as a single file.
- `--out-shards <dir>` writes one file per leading address byte, `<xx>.json` holding `{ root, claims }`, plus `manifest.json` (`root`, `count`, `totalWei`,
  `unitScale`, `shards`): at most 256 files however many recipients. This is the layout published for the live airdrop (`dapp/airdrop/v1/proofs`).
- Leaf: `keccak256(keccak256(abi.encode(index, account, amount)))`. Node: keccak of the sorted pair.
- The Solidity tests read proof files this tool wrote (`contracts/test/fixtures/airdrop/`, regenerated with `node
  contracts/test/fixtures/airdrop/generate.mjs`) and check them against the contract's verifier and claim paths, so the two
  implementations are pinned to each other.

## 5. Guardian runbook

**Deployment parameters.** Each constructor argument comes from
[`contracts/deployments/1.json`](../contracts/deployments/1.json), so it can be checked rather than retyped:

| Argument | Source |
| --- | --- |
| `token` | `tacToken` |
| `root` | printed by `airdrop-tree.mjs` |
| `guardian` | `engineAdmin` (the ops multisig) |
| `deadline` | unix seconds; `CLAIM_DEADLINE` on the contract |
| `pool` | `pool` |
| `assetId` | `tacAssetId` |

The constructor refuses a token, pool or asset id that is not a registered pool-minted TAC asset, a guardian with no
code, a zero root, and a deadline that is not in the future or is more than 400 days out. It cannot tell a wrong
guardian that happens to be a contract, so `airdrop-verify` checks the guardian, token and pool against the manifest.
The contract is funded with exactly the tree total; check `balanceOf(airdrop) >= totalWei`. A short balance is not
unsafe (a claim that cannot be paid reverts and leaves the leaf claimable, and a top-up fixes it).

**During the window**

- `pause()` blocks every claim and moves nothing; `unpause()` reopens. Pausing does not extend the deadline, and
  unpausing after the deadline reopens nothing, so a pause held to the deadline denies every claim.
- `sweep(to, amount)` moves TAC out at any time. To abandon the airdrop, queue `pause()` and the full sweep together;
  they do not need to be serialised. Claims made before the sweep stay paid.
- `sweepToken(token, to, amount)` recovers other tokens sent to the contract by mistake, or ETH with `token = 0x0`.
  Sending ETH to the contract directly reverts.

**At the deadline**

Claims revert from the second after `CLAIM_DEADLINE`. The guardian then calls `sweep(to, balance)` for the remainder.
Unclaimed allocations are not claimable after that.

**Gas** (mainnet fork, whole transaction including the 21,000 base, real TAC and pool, 1,024 leaves = 10 proof words)

| Path | First claim in a bitmap word | Later claim in the same word | Deploy |
| --- | --- | --- | --- |
| `claim` | 88.3k | 71.2k | 674k |
| `claimTo` | 88.1k | about 71k | |
| `claimAndShield` | 108.8k | 91.7k | |

A 100,000-leaf tree needs 16 or 17 proof words and adds about 4k gas per claim (claim 92.7k, `claimAndShield` 112.6k). A word
covers 256 indexes; the first claim in a word pays the 20k storage set. The live tree's largest proof is 14 words.

## 6. Claiming into a farm

An allocation is all or nothing. To put some or all of it into the TAC/cETH farm (pid 0, [`FARMS.md`](./FARMS.md)),
claim it in the clear, wrap the TAC and a matching cETH leg, and bond them with `tacit.lpBond`; size the cETH leg with
`tacit.quoteLpAdd` first ([`INTEGRATOR-PLAYBOOK.md`](./INTEGRATOR-PLAYBOOK.md#1-zap-into-a-farm) section 1). A
retired pool still accepts TAC deposits, because TAC is pool-minted, but the farm and the pair belong to the active
pool: check `successor()` before running the flow.

## 7. Properties

- The public proofs let anyone deliver a recipient's claim, always to the recipient (section 2).
- The guardian can pause or sweep at any time, subject to the multisig's delay (section 1).
- A token or pool that behaves unlike TAC and the live pool is refused at deployment; the contract is only meant for
  this pair.
