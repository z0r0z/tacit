# TacProvenOracle

The TAC vaults' oracle from one SP1 proof per update. The proof reads what the two venue oracles record (each
50-block interval's RANDAO-picked sample block, the Precision pool's and the confidential pool's end-of-block
reserves) for every interval the windows need, checks the headers back to a recent block, and commits the answers the
vaults read. `record` checks the anchor against BLOCKHASH, verifies the proof and stores them, and takes a proof only
while its interval X is one of the two newest whose following block exists, so what is stored is at most one interval
behind. Every proof answers for the same five intervals from its own (X - 1 to X + 3); a view the proofs do not cover
is answered by the pair oracle the vaults use today (`0x000000cE…1271`). `latest` is the proof's price at X while a proof
covers the interval that counts, so at most four intervals old. The constructor checks that the pair's venues read the
same pools, slots, pool id and coverage share as the program, and that STEP, the windows and COUNT are values the
program and the venues can use together.

The pair is still recorded the slow way, and through the proven oracle too: a venue oracle's `record` with one more
`proofB` element, a byte naming the venue (0 the Precision venue, 1 the AMM venue), goes on to that venue. So a
borrower can always record what is missing in the borrow's own transaction, through the router, as today.

It goes into the live vaults through their `queueOracle` / `executeOracle` (three days). The vaults, their tokens and
TacVaultRouter stay as they are: the oracle keeps the venue oracles' `record` selector and is its own `A()` and `B()`.

| | pair oracle | proven oracle |
|---|---|---|
| prices for the whole 8-hour window after a gap | about 91M gas, 96 records, about 8 transactions | about 0.3M gas, one transaction (0.35M for the first record) |
| borrow / withdraw / liquidate / bid | 630k / 443k / 955k / 2.46M | 132k / 104k / 87k / 140k |

## Parts

- `contracts/src/TacProvenOracle.sol`: the oracle. Tests: `contracts/test/TacProvenOracle.t.sol` (run with
  `forge test --match-path test/TacProvenOracle.t.sol`).
- `contracts/sp1/tac-oracle/core`: what the program computes, a plain library (`cargo test --release`); its cases are
  checked against TacPairOracle by the Solidity tests (`test/fixtures/tac-proven/cases.json`).
- `contracts/sp1/tac-oracle/program`: the SP1 program. `build-program.sh` builds it in Docker and writes
  `elf/tac_oracle` and `elf-vkey-pin.json`.
- `contracts/sp1/tac-oracle/host`: `tac-oracle-host input | execute | prove | vkey` (see `src/main.rs`).
- `contracts/script/DeployTacProvenOracle.s.sol`: deployment and the ops multisig calls.

## Steps

1. The program: `elf/tac_oracle` and `elf-vkey-pin.json` are committed. CI (`tac-oracle-elf.yml`) rebuilds it in SP1's
   Docker image and fails if the rebuild, the committed ELF and the pin differ; `build-program.sh` does the same
   locally. A program change rebuilds both in one commit and needs a new oracle.
2. On a GPU box (24 GB), `host/prove-on-box.sh <tac-oracle dir> <ELF>` builds the host with CUDA and the SP1 6.2.4
   stack (from `host/Cargo.box.lock`), reads a fresh input and proves it; by hand:
   ```
   tac-oracle-host input --oracle <oracle> --dir d
   SP1_PROVER=cuda tac-oracle-host prove --elf elf/tac_oracle --dir d    # d/proof.json
   ```
   On an RTX 4090: the input (2,450 headers and 98 proofs from public nodes) about 80 s, the proof 79 s.
   Send `d/proof.json` to `record`, refreshed as each interval ends.
   To keep one ready, run `ORACLE=<oracle> ELF=<ELF> host/serve-proofs.py` on the box: it proves each interval as it becomes provable and
   serves the newest at `GET /proof.json` (and `/status`), holding no key. The keeper reads it with `PROOF_URL=http://<box>:8787/proof.json`.
3. Deploy: `PROGRAM_VKEY=<pin's program_vkey> GRACE=<blocks, 1 to 49> forge script script/DeployTacProvenOracle.s.sol
   --rpc-url $RPC --broadcast --account <funded account>`. It refuses a key that is not the pin's, and prints the
   oracle, its CONFIG and the multisig calls.

   `SALT` picks the address. Left out, it is the CREATE2 default, where the address also pins this init code. A salt
   whose first 20 bytes are the deployer and whose 21st is 0x00 is one the salt pool mined for a CREATE3 vanity
   address: the script then deploys through CREATE3, which only that deployer can do. A CREATE3 slot is single use,
   so check the address has no code first — the pool's bank keeps a salt after it is spent, and several in it are.
   A CREATE3 address does not depend on the code at it, so read the terms the script prints off the chain.
4. Ops multisig: `queueOracle(<oracle>)` on both vaults (one `batch` call is printed).
5. Within the three days: a prover recording proofs, and one proof recorded.
6. Ops multisig: `executeOracle()` on both vaults, after the delay and while a proof covers the interval that counts
   (the vault checks the oracle answers every view). Queue it at least an hour ahead; anyone can release it, in the
   same transaction as a proof.

`GRACE` is how many blocks after an interval ends before it counts. A proof holds the depth the vault reads for only
two intervals (X - 1 and X), so borrowing stays open while the proof of each interval lands within `GRACE` blocks of
that interval's end; a proof can be made once the interval's following block is out. Prices then lag by `GRACE` to
`GRACE + 50` blocks. With a proof about three minutes after an interval ends, `GRACE = 30` (six minutes) leaves room
for a slow node or a busy block, but not for a prover that has to start up first: keep one warm.

A proof whose interval is no longer one of the two newest reverts `StaleProof`. TacVaultRouter lets only
`AlreadyRecorded` through, so a transaction that carries such a proof reverts as a whole and is rebuilt with a newer
one; simulate before sending.

Recording a proof for every interval costs about 0.3M gas each; between proofs, borrowing rests on borrowers
recording the pair.

Going back: `queueOracle(0x000000cE…1271)` and `executeOracle()` three days later. Without a covering proof the proven
oracle already answers from the pair.
