# TacProvenOracle

The TAC vaults' oracle from one SP1 proof per update. The proof reads what the two venue oracles record (each
50-block interval's RANDAO-picked sample block, the Precision pool's and the confidential pool's end-of-block
reserves) for every interval the windows need, checks the headers back to a recent block, and commits the answers the
vaults read. `record` checks the anchor against BLOCKHASH or EIP-2935, verifies the proof and stores them. Every proof
answers for the same five intervals from its own (X - 1 to X + 3); a view the proofs do not cover is answered by the
pair oracle the vaults use today (`0x000000cE…1271`).

The pair is still recorded the slow way, and through the proven oracle too: a venue oracle's `record` with one more
`proofB` element, a byte naming the venue (0 the Precision venue, 1 the AMM venue), goes on to that venue. So a
borrower can always record what is missing in the borrow's own transaction, through the router, as today: the page
sends the newest posted proof when there is one, and the pair's missing intervals otherwise.

It goes into the live vaults through their `queueOracle` / `executeOracle` (three days). The vaults, their tokens and
TacVaultRouter stay as they are: the oracle keeps the venue oracles' `record` selector and is its own `A()` and `B()`.

| | pair oracle | proven oracle |
|---|---|---|
| prices for the whole 8-hour window after a gap | about 91M gas, 96 records, about 8 transactions | about 0.25M gas, one transaction |
| borrow / withdraw / liquidate / bid | 630k / 443k / 955k / 2.46M | 131k / 103k / 86k / 139k |

## Parts

- `contracts/src/TacProvenOracle.sol`: the oracle. Tests: `contracts/test/TacProvenOracle.t.sol` (run with
  `forge test --match-path test/TacProvenOracle.t.sol`).
- `contracts/sp1/tac-oracle/core`: what the program computes, a plain library (`cargo test --release`); its cases are
  checked against TacPairOracle by the Solidity tests (`test/fixtures/tac-proven/cases.json`).
- `contracts/sp1/tac-oracle/program`: the SP1 program. `build-program.sh` builds it in Docker and writes
  `elf/tac_oracle` and `elf-vkey-pin.json`.
- `contracts/sp1/tac-oracle/host`: `tac-oracle-host input | execute | prove | vkey` (see `src/main.rs`).
- `tools/tac-vault-keeper.mjs`: `PROVEN=<oracle>` with `PROOF_URL` or `PROOF_CMD`.
- `dapp/vault/feed.js`: a vault whose oracle answers `coverage()` is kept up from `DEPLOYMENTS.proofUrls`.
- `contracts/script/DeployTacProvenOracle.s.sol`: deployment and the ops multisig calls.

## Steps

1. Build the program: `contracts/sp1/tac-oracle/build-program.sh`. Commit `elf/tac_oracle` and `elf-vkey-pin.json`.
2. On a GPU box (24 GB), `host/prove-on-box.sh <tac-oracle dir> <ELF>` builds the host with CUDA and the SP1 6.2.4
   stack (from `host/Cargo.box.lock`), reads a fresh input and proves it; by hand:
   ```
   tac-oracle-host input --oracle <oracle> --dir d
   SP1_PROVER=cuda tac-oracle-host prove --elf elf/tac_oracle --dir d    # d/proof.json
   ```
   On an RTX 4090: the input (2,450 headers and 98 proofs from public nodes) about 80 s, the proof 79 s.
   Post `d/proof.json` where the page and the keeper read it (`proofUrls`, `PROOF_URL`), refreshed as each interval
   ends; or run the two commands as the keeper's `PROOF_CMD`.
3. Deploy: `PROGRAM_VKEY=<pin's program_vkey> GRACE=<blocks, 1 to 49> forge script script/DeployTacProvenOracle.s.sol
   --rpc-url $RPC --broadcast --account <funded account>`. It refuses a key that is not the pin's, and prints the
   oracle, its CONFIG and the multisig calls.
4. Ops multisig: `queueOracle(<oracle>)` on both vaults (one `batch` call is printed).
5. Within the three days: a prover posting proofs, `proofUrls` set in `dapp/vault/deployments.js` (then
   `npm run build`), the keeper running with `PROVEN`, and one proof recorded.
6. Ops multisig: `executeOracle()` on both vaults, after the delay and while a proof covers the interval that counts
   (the vault checks the oracle answers every view). Queue it at least an hour ahead; anyone can release it, in the
   same transaction as a proof.

`GRACE` is how many blocks after an interval ends before it counts. A proof can be made once the interval's following
block is out, so a prover that posts within `GRACE` blocks keeps borrowing open without a pause; prices then lag by
`GRACE` to `GRACE + 50` blocks. With a proof about three minutes after an interval ends, `GRACE = 30` (six minutes)
leaves room for a slow node or a busy block.

With `RECORD_MODE=demand` the keeper proves only while a borrower is near the line; borrowing between proofs then
rests on `proofUrls` or on borrowers recording the pair. A keeper that proves every interval costs about 0.25M gas each.

Going back: `queueOracle(0x000000cE…1271)` and `executeOracle()` three days later. Without a covering proof the proven
oracle already answers from the pair.
