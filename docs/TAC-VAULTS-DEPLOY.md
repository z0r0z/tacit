# TAC vaults: public deployment

The TAC vaults are deployed by anyone, in a handful of transactions, to addresses fixed in advance. Nothing about the
sender matters: the addresses commit to the exact code, constructor arguments and owner, so the only thing a deployer
chooses is whether to pay the gas.

This plan is deployed on Ethereum mainnet. The addresses are in `contracts/deployments/tac-vaults.json` and
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md#tac-vaults), and the dapp reads them from `dapp/vault/deployments.js`.

## How it is fixed

Each contract goes through CreateX (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`) with `deployCreate2(salt, initCode)`.
The salt is tied to no sender, so any account can send it, but to this chain (it starts with 20 zero bytes and the
flag `0x01`, which CreateX hashes with the chain id). The address is

    CREATE2(CreateX, keccak256(abi.encode(chainId, salt)), keccak256(initCode))

Because the init code carries the constructor arguments, a different owner, parameter or contract gives a different
hash and so a different address. Different code cannot take a planned address, a planned address cannot be taken
by anything but its own code, and no one can take the same addresses on another chain. (CREATE3 would not give this: its address ignores the init code, so anyone could land
other code there first.) Each address begins with three zero bytes, found by `tools/vanity-create2`.

Later contracts take earlier addresses as arguments, so they are fixed in order: the two venue oracles, their pair, the
ETH feed, the two vaults (a vault's synth is its first contract, so its address follows), then a pool and router for TAC
and for each synth, then a zap per vault. `contracts/deployments/tac-vaults.json` lists every salt, init code hash,
constructor argument blob and address; `contracts/script/TacVaultsDeployment.sol` holds the same as constants.

The owner of both vaults, and the recipient of fees and absorbed TAC, is the ops multisig
`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`. All other settings are in `contracts/deployments/tac-vaults.config.json`.

## Deploying

With Foundry, from `contracts/` (any funded account will do; the build must use the project's settings):

    forge script script/DeployTacVault.s.sol --rpc-url $RPC --broadcast --account <account>

The script rebuilds each init code from the compiled contracts and refuses to send one whose hash or address differs
from the plan. A contract that is already at its address is skipped, so a partial or repeated run is safe, and anyone
can finish what another started. Afterwards it registers both synths in the confidential pool and creates the five
pairs (each only if missing), and checks the result. Dry-run it first by leaving out `--broadcast`: 21 transactions,
about 44M gas.

Without Foundry, send the transactions in `payload.json` (written by `tools/tac-vaults-plan.mjs --payload`, below) in order
(`to`, `data`, `value` 0): 14 to CreateX, then 7 to the confidential pool. A page can do the same: for each deployment,
read the code at `expectedAddress` and send the transaction only if there is none; check `tools/tac-vaults-check.mjs`
passes for the payload it ships.

## The router

`contracts/src/TacVaultRouter.sol` is a separate, later contract for one thing: a person who wants to borrow (or take TAC out with a
debt) while the oracle waits for price records can make the records, move TAC in with a permit and borrow on a signature in **one
transaction** from any wallet. A vault acts for its caller, so a shared batcher cannot carry the action; the router can because it acts only
for `msg.sender` (the TAC is theirs, the vault credited is theirs, the recipient is the signer). It is stateless, has no owner or
settings, is bound at construction to the two vaults, and records only on the venues of the oracle such a vault reads. Wallets that can
send a batch themselves (EIP-5792) do not need it: the dapp uses their batch first.

    forge script script/DeployTacVaultRouter.s.sol --rpc-url $RPC --broadcast --account <account>

It deploys through CreateX like the rest (a chain-bound salt: the default is mined for an address with three leading zero bytes,
`0x000000F9ab49650502BeC910D13b4717F0082598`; `ROUTER_SALT` sets another), checks its bindings, and prints the address to put in `dapp/vault/deployments.js` (`router`).
The router is deployed at that default address, and `deployments.js` names it.

## Checking

- `node tools/tac-vaults-check.mjs payload.json contracts/deployments/tac-vaults.json` re-derives every hash and address
  from the payload with `cast` alone and checks the manifest agrees.
- `DeployTacVault.verifyAll()` (run by the script) checks the owners, wiring, the depth share the vaults were deployed with
  and the venue storage slots against the live pools. It can be called on its own. The registry entries are checked as
  `registerAll()` reads each one back.
- `node tools/tac-vaults-etherscan.mjs` prints the `forge verify-contract` commands.

## After deployment

Lending opens once the oracle has recorded the whole 8-hour window: run `tools/tac-vault-keeper.mjs` with
`ORACLE=<Precision oracle>,<AMM oracle>` (see its header). Until then every priced function fails closed and repayment
and debt-free withdrawal work. The owner's tools are in `tools/tac-vault-admin.mjs`.

## Where the tokens sell

A borrowed token is worth what it sells for. `dapp/vault/deployments.js` (`pools`) lists the Precision pools worth opening for each token, and the vault page (`dapp/vault/pools.js`)
shows them under the board. Two for each token and no more, each against the asset the token tracks: a tight ±10% **peg** band at 0.05%, where the price is made, and a wide
×0.5–×2 **backstop** at 0.3%, which still trades if the peg breaks. TACD sells against USDC, TACE against ETH. Anyone can open one: with nothing typed the button creates the pool
(one transaction, no tokens); with amounts typed it creates and seeds it in the same transaction, or adds to it if it exists. Pools that others open for the token, against USDC or
ETH and with no hook, are found from the factory and listed after these.

| Market | Fee | Band | Pool |
| --- | --- | --- | --- |
| TACD / USDC peg | 0.05% | 0.9 – 1.111 USDC | [`0xDfEE03499f65E56D54aCeEEdc6F41A09FBEB94B3`](https://etherscan.io/address/0xDfEE03499f65E56D54aCeEEdc6F41A09FBEB94B3) |
| TACD / USDC backstop | 0.3% | 0.5 – 2 USDC | [`0x867918fD7B6D4F13A20048485147867B9A597534`](https://etherscan.io/address/0x867918fD7B6D4F13A20048485147867B9A597534) |
| TACE / ETH peg | 0.05% | 0.9 – 1.111 ETH | [`0x386627b60CD2A11365e653f0382d92421fddF7a1`](https://etherscan.io/address/0x386627b60CD2A11365e653f0382d92421fddF7a1) |
| TACE / ETH backstop | 0.3% | 0.5 – 2 ETH | [`0xe1E317700589F3EaFCA20Ac9408c97fE700fC1C1`](https://etherscan.io/address/0xe1E317700589F3EaFCA20Ac9408c97fE700fC1C1) |

- **A market is its tuple.** The factory derives the pool's address from the two tokens, the band, the fee and the fee recipient, so none of them changes afterwards, and changing a
  number in `deployments.js` points the page at a different pool. The templates are unnamed (no fee recipient), so anyone can open them; the cost is that someone can open one first
  at a price of their own, which on a ±10% band is arbitraged back inside the band and which the page says (a deposit into a pool trading 3% or more from its peg is told so).
- **Why bands.** A swap that would leave the band is refused, so the band decides both the price and the exit. Measured against the pool itself on a fork, a $200 pool (100 + 100)
  selling 25 tokens gives up 19.52% across a full range, 6.87% at ×0.5–×2, 1.32% at ±10% and 0.68% at ±5%. The cost of a tight band is the tail: if the token fell to $0.80, a ±10%
  depositor is 8.7% behind holding and a full-range one 0.6%. Hence a tight tier for the price and a wide tier for the fall.
- **How much there can be.** TACD and TACE exist only as debt, and each vault lends at most `DEPTH_BPS` (55) of the TAC pools' smallest ETH depth over the oracle's longest
  window (`depthCeiling()` reads it), against a smallest debt of $10 of TACD or 0.004 TACE. The first liquidity therefore comes from an account that borrowed (1% fee) and holds
  the other side. Raising the room is a parameter, not a pool: the owner can raise `DEPTH_BPS` to at most 1,000 after a 2-day announcement. `tests/vault-page.mjs` opens the
  markets against the live factory's code on a local chain, in both token orders.

## Changing anything

A change to a contract or to the config changes init code hashes, so the plan is made again:

    node tools/tac-vaults-plan.mjs --out contracts/out --payload payload.json

It mines the addresses in order (about a minute) and rewrites the manifest and the constants. Run the fork tests
(`forge test --match-path test/TacDeployFork.t.sol`, with `FORK_URL`) and commit the manifest and constants together.

## What a stranger can and cannot do

- Send the deployment, or part of it, in any order the contracts' constructors allow: the result is the same.
- Land the right code early: harmless, that is the plan.
- Land different code or a different owner under any planned salt: it lands at another address.
- Deploy the plan on another chain at the same addresses: the salts are bound to chain 1, so they land elsewhere.
- Register a synth or create a pair in the confidential pool first: a plain token's asset id comes from the token alone and
  takes no cross-chain link, and a pair's id includes its fee, so the entry is the one the script needs, and the script
  reads the terms back.
- Pre-fund an address: no effect.
