# Sending and proving confidential-pool ops yourself

`ConfidentialPool.settle(publicValues, proof, memos)` is open to any account. The pool checks the proof
against its pinned program key, applies every effect the proof commits to, and pays each fee leg the proof
binds to `msg.sender`. Who sends a settle changes nothing else. That leaves three roles anyone can take:

- **Send a proof that is waiting** (the open board) and earn its fee.
- **Prove an op with your own Succinct prover account**, then send it yourself or post it to the board.
- **Pay for the relay's proofs** with PROVE.

To run a whole relay (take actions from pages, prove them and send them), see [RUN-A-RELAY.md](./RUN-A-RELAY.md).

API base `https://api.tacit.finance`. Every route here is public and CORS-open.

## The open board

A proof lands on the board in one of two ways:

- **Proved by the relay but not sent yet.** The relay sends relayed (`mode: 'settle'`) jobs itself. While
  it can't pay for a settle, it keeps proving the ones any account could send and puts them on the board.
- **Posted by its holder** with `mode: 'preproven'`.

| route | |
|---|---|
| `GET /confidential/open?limit=` | `{ pool, jobs }`, oldest first (the list can be up to five seconds old). Each job has `{ jobId, type, status, posted, free, publicValues, proof, memos, openSince, expiresAt, feeUsd, feeAsset }` (`free`: a step with no fee in it, such as a private send's lock, whose claim pays the relay). `status` is `open`, or `sending` while a relay has taken the job to send; a send that never finishes goes back to `open` after five minutes. `expiresAt` is in ms (0 means none). |
| `POST /confidential/landed` | `{ jobId, txHash }`. Closes the job once the API sees that the transaction succeeded, reached the pool, carries the job's public values, and that the same settle would now be refused. |
| `POST /confidential/submit` | `{ type, mode: 'preproven', publicValues, proof, memos }` posts your own proof. Its settle is simulated first, and a proof the pool would refuse now is turned away. The same public values posted twice are one job. |
| `GET /confidential/status?id=` | One job's status. An open job carries the same proof and memos as on the board. |

**What goes on the board.** Only ops whose settle is a plain `pool.settle`:

- **Never listed:**
  - router-embedded proofs: `wraptransfer`, `wraplp`, `wrapswap`, `wrapcdpmint` (a posted `wrapswap` whose deposit
    already waits in the pool settles as a plain `pool.settle`, and is listed);
  - proofs pinned to a root that moves with the reflection: `bridgemint`, `cbtcmint`, `fastlane`;
  - adaptor-swap legs (`adaptorlock`, `adaptorclaim`, `adaptorrefund`): when one lands is part of the swap;
  - relayed exits that carry an L2 recipe for the relay to activate. A holder may post such an exit; Tacit's relay
    activates its recipe when it sends it.
- **Leaving the board:** a relayed job stays until its own deadline. A posted proof also leaves after a day if
  nobody sent it. A landing closes every job on the board that carries the same proof.

**Reading a job's fee.** `publicValues` is `abi.encode(PublicValues)` of the struct in
[`ConfidentialPool.sol`](../contracts/src/ConfidentialPool.sol).

- Word 0 is the tuple offset.
- Head word 8 points to `fees`, a list of `{ bytes32 assetId, uint256 value }` in the pool's units. Multiply
  `value` by the asset's `unitScale` from [`confidential-deployments.js`](../dapp/confidential-deployments.js).
- Head word 16 is the settle `deadline` in unix seconds (0 means none).

[`worker/src/confidential-open.js`](../worker/src/confidential-open.js) reads these fields and builds the call.

**The board on Nostr.** The same proofs are also posted to public Nostr relays (`wss://relay.damus.io`,
`wss://nos.lol`, `wss://relay.primal.net`, `wss://offchain.pub`), so the board does not depend on this API.

- **Who posts them:** holders whose page proved an action for anyone to send, /prove/ tabs, and
  `community-runner` copying this API's board.
- **The event:** kind 30078 with tags `t` = `tacit-board-v1`, `d` = `tacit-board-v1:<sha256 of the public values>`,
  a NIP-40 `expiration` and a NIP-13 `nonce` (12 bits of work). The content is JSON
  `{ v: 1, chainId, pool, type, publicValues, proof, memos, expiresAt }`.
- **The keys:** each post is signed with a key made for it alone.
- **Checking:** [`dapp/nostr-board.js`](../dapp/nostr-board.js) posts, reads and checks them. Trust nothing in a post:
  simulate the settle before sending.

**Running a relayer.** [`worker-relay/src/open-relayer.js`](../worker-relay/src/open-relayer.js) is a
complete one. It:

1. reads the board;
2. picks the oldest job whose tETH fee covers the settle's gas with a margin;
3. simulates the settle;
4. sends it through Flashbots Protect, so a reverting copy is never mined and the calldata stays private
   until it lands;
5. reports the landing.

```sh
cd worker-relay && npm ci
RELAYER_KEY=0x… RPC_URL=https://… node src/open-relayer.js     # MARGIN_BPS=2000 POLL_SECS=15 ONCE=1
```

[`tools/community-runner.mjs settles`](../tools/community-runner.mjs) does the same from the repository root with no
`worker-relay` install, beside the header and proof modes ([COMMUNITY-OPS.md](./COMMUNITY-OPS.md)).

`open-relayer.js` is the smallest one: it reads this API and counts tETH fees only.
[`tools/community-runner.mjs`](../tools/community-runner.mjs) `settles` also reads the Nostr board and counts TAC
fees ([COMMUNITY-OPS.md](./COMMUNITY-OPS.md)).

Other senders take jobs too, Tacit's relay among them. Simulate before every send: if you lose the race,
the cost is that simulation, not a reverted transaction.

## Proving with your own prover account

Tacit's relay proves on the [Succinct prover network](https://docs.succinct.xyz/docs/sp1/prover-network/quickstart)
and pays for it from its own prover account. You can do the same from yours. Then nothing depends on the
relay's queue or credit, and your op's witness goes from your machine to the network only.

1. **Fund the account.** Deposit PROVE into the network's vApp
   (`SuccinctVApp.deposit`, `0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F`; PROVE is
   `0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29`).
   - The deposit credits the account that sends it. The account must be an EOA, because the network
     checks requests with `ecrecover`.
   - The network credits the deposit once indexed, which takes up to about five minutes. The minimum is
     0.01 PROVE.
   - A groth16 request needs about 1 PROVE on hand and spends about 0.4.
2. **Prove the op.** Use the same `{ type, op, memos }` a page sends to `/confidential/submit`. The op
   builders in `confidential-pool-ux.js` and the fixtures in `contracts/sp1/confidential/fixtures/` show
   each type's shape. The `exec-<op>` binary for the type proves it.
3. **Send it, or post it.**
   - Send `settle()` from any account; you are paid the fee legs you bound, so a fee you set comes back to you.
   - Or post the proof to the board, and whoever sends it is paid that fee.

[`worker-relay/src/self-prove.js`](../worker-relay/src/self-prove.js) does all three:

```sh
cd worker-relay && npm ci
export NETWORK_PRIVATE_KEY=0x… RPC_URL=https://…
node src/self-prove.js deposit 5                  # approve + deposit 5 PROVE for this key's account
node src/self-prove.js prove job.json --send      # prove with your credit, then settle from SETTLE_KEY (default: the same key)
node src/self-prove.js prove job.json --post      # prove, then put it on the open board
```

**The prover binaries.** These are the Linux x86-64 builds in the `prover-bins` release that
[`worker-relay/Dockerfile`](../worker-relay/Dockerfile) names. They embed the pool's pinned guest, and
`self-prove.js` checks each one against `worker-relay/prover/bin/SHA256SUMS` before running it.

- On another system, build the relay image and run the script inside it:
  `docker build -t tacit-relay worker-relay` then
  `docker run --rm -e NETWORK_PRIVATE_KEY -e RPC_URL -v "$PWD:/job" tacit-relay node src/self-prove.js prove /job/job.json --post`.
- To build them yourself, use
  [`contracts/sp1/confidential/build-all-network.sh`](../contracts/sp1/confidential/build-all-network.sh).

**Who sees the witness.** The network request carries it as a private input (`private_stdin`), and `self-prove.js`
names Succinct's own prover (`0xd4fcfce0…a4f5`) as the only one that may take it (`PROVER_WHITELIST`). Only the
network's executor and that prover can read the witness; Tacit's relay never sees it. The provers that win the open
auction take private requests and do not deliver them, so a private request sent to all provers waits out its
deadline (and still pays the base fee). `PRIVATE_STDIN=0` sends a public input to any prover instead.

### From the site

[tacit.finance/#prove-self](https://tacit.finance/#prove-self) and the tETH page prove in the browser, with no
binaries:

- **The account.** Your Tacit account (the Ethereum account your Tacit key derives) is the requester. Its credit pays,
  and it signs each request itself.
- **Funding.**
  - **PROVE from your connected wallet:** the wallet sends PROVE to the Tacit account (only what it lacks). It then sends
    the vApp's `permitAndDeposit` with a permit the Tacit account signs.
  - **ETH:** the wallet pays ETH that zRouter swaps to PROVE for the Tacit account, then the same deposit follows.
- **Cost.** A request needs about 0.46 PROVE on hand (0.58 for liquidity ops, which may use more gas) and spends about
  0.39.
- **Privacy.** A request is private and goes to Succinct's own prover only, as above. If it is not proved by its
  deadline, nothing is sent, and the network keeps its base fee. While the network refuses private inputs
  (`PERMISSION_DENIED`, which costs nothing), the request goes with a public input instead, open to any prover, and the
  page says so as it goes and on the result. `makeSelfProver({ input: 'private' })` keeps it private only. The relay's own
  proofs go first to Tacit's prover board (below), a machine Tacit runs, where a relayed op's witness stays with Tacit; a
  proof the board does not take in time is requested from the network, with the witness as a public input while the
  network refuses private ones. A settled job's `lane` says which way it went: `board`, `network-private` or `network-public`.
- **The settle** is sent from your connected wallet.
- **The proxy.** The network's artifact store sends no CORS headers, so the page's input goes up through
  `POST /prover/upload` and the finished proof comes back through `POST /prover/download` on the API. Both forward bytes
  to the store's own hosts and keep nothing.

The same modules work in any page or in Node:

- [`dapp/sp1-stdin.js`](../dapp/sp1-stdin.js) builds the program input for every op a page sends, byte for byte as the
  `exec-<op>` harnesses do.
- [`dapp/succinct-net.js`](../dapp/succinct-net.js) is the network client.
- [`dapp/self-prover.js`](../dapp/self-prover.js) joins them into the `prove` that `relay.useProver` takes, and builds
  the funding transactions.
- From Node, pass `proxyBase: null` (the input goes straight to the store) and an HTTP/2 `transport`. The network's RPC
  refuses HTTP/1.1.

## Proving for the relay

The relay can offer each settle proof to its own prover board before it asks the prover network: a machine with a
24 GB-class NVIDIA GPU pulls the program input, proves it with the pinned guest and posts the proof back, and the relay
checks the proof against the pool (the same simulated settle it runs before sending) before it uses it. A job nobody
proves in time goes to the network as before, so a worker that stops only stops helping.

| route | |
|---|---|
| `GET /prover/board` | `{ queued, claimed, proved, failed, workers: [{ name, proved, failed, bad, lastSeenSeconds, pubkey? }], lease }`, for anyone. No inputs, no proofs. `pubkey` is the compressed secp256k1 key a worker takes sealed inputs under (below). |
| `POST /prover/claim` | Worker token. `{ worker, classes }` → `{ job: { jobId, program, stdin, cycleLimit, gasLimit, deadline, leaseUntil, label } }`, or `{}`. `stdin` is base64 of the bincode `SP1Stdin`. The claim is a lease (five minutes); a worker that goes quiet loses the job to the next claim. |
| `POST /prover/result` | Worker token. `{ jobId, publicValues, proof }` (hex; `proof` as `settle()` takes it) or `{ jobId, error }`. |

**Who may prove what.** The API knows each worker by a bearer token (`PROVER_WORKER_TOKENS`, `name:token[:classes]`).
The `private` class carries a user's witness, so it goes only to workers Tacit runs or has named for it; the `public` class
is work whose input is public anyway. A proof the pool refuses counts against its worker and the job goes on to the network.
Public jobs are also open to anyone with no token, named by the address their points go to: `POST /prover/community/claim`
and `/prover/community/result` (the `board` mode in [COMMUNITY-OPS.md](./COMMUNITY-OPS.md#board-opt-in-not-part-of-all)).

**Sealed inputs.** A page can keep an op from the relay and the API altogether: it builds the program input itself
(`dapp/sp1-stdin.js`, the same bytes the relay would build), encrypts it to one worker's `pubkey` from the board
(`dapp/sealed-input.js`: secp256k1 ECDH with a one-time key, SHA-256 over the domain `tacit-sealed-input-v1`, the shared
x-coordinate and both keys, then AES-256-GCM with that domain as the associated data) and posts
`POST /confidential/submit` `{ type, mode: 'sealed', sealed: { worker, epk, iv, ct }, memos }`. The API queues the
ciphertext for that worker only; the relay offers it on the board, and the worker opens it with its key
(`prover-worker/src/main.rs`, `unseal`; the key lives in `WORKER_KEY_FILE`, made on first start and sent with each claim).
Nothing else reads the op: the relay reads the fee from the proof's own legs and holds each to the floor this API publishes
for its asset (`GET /confidential/quote`; tETH, TAC, cUSD and cBTC are priced, so a sealed op must pay its relay fee in one of
them, or it is refused), and simulates the settle as for any proof. An op that carries no fee by design (a private send's
lock) is sealed too and metered on the relay's free-settle budgets by its type at submit, as in the clear. A sealed job is never sent to the prover network: while
the worker it is sealed to has not polled in a minute the submit is refused (`503`, code `sealed_unavailable`), and one
the worker fails is failed, so the page sends it again or unsealed. The site offers this under *Prove it yourself → Seal
my actions to Tacit's prover machine*; a settled sealed job reads `sealed: true` on its status.

**Running a worker.** [`contracts/sp1/confidential/prover-worker/`](../contracts/sp1/confidential/prover-worker/) is the
worker: one binary that builds the CUDA prover and the proving key once, warms the Groth16 stages at start, then claims,
proves and answers one job at a time.

```sh
contracts/sp1/confidential/prover-worker/setup-box.sh      # as root on a fresh box: the toolchain, then cargo build --release
cd contracts/sp1/confidential/prover-worker
BOARD_URL=https://api.tacit.finance WORKER_TOKEN=… WORKER_NAME=gpu1 EXPECT_VKEY=<the pool's PROGRAM_VKEY> ./target/release/tacit-prover-worker
```

It needs Linux x86-64, CUDA 12, a GPU with 24 GB of memory, 8 or more CPU cores and 50 GB of RAM, and about 10 GB of disk
for the Groth16 artifacts the SDK fetches on the first proof. `run-worker.sh` in the same directory keeps the worker
running on a rented pod (restart on a crash, GPU leftovers cleaned, thread counts from the pod's CPU quota, the server
and artifacts put back after a container restart) and `restart-worker.sh` restarts it; Tacit's own worker proves an
ordinary op in about 35 s on a $0.27/h RTX A5000 with the GPU server built for Groth16 on the GPU (see `sp1-gpu/`).

## Paying for the relay's proofs

Every proof Tacit's relay makes is paid in PROVE from its prover account,
`0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`.

- **How soon it is used.** PROVE sent there goes into the prover network within a few minutes once 2 PROVE
  or more has arrived. Smaller amounts go in at the relay's next half-hourly top-up.
- **What it buys.** About 0.4 PROVE pays for one proof.
- **Where to do it.** [tacit.finance/relay/#prove](https://tacit.finance/relay/#prove) sends PROVE, or pays
  ETH that zRouter swaps to PROVE for that account in one transaction.
