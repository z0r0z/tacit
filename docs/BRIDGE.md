# The Tacit bridge

TAC, tETH and cBTC move between Bitcoin and Ethereum by proof. Each chain's state is proven to the other
in zero knowledge, and a bridge waits for a proof, never for a signature. No multisig, federation or
attestor set signs a bridge message. Nothing on Bitcoin had to change for it: it runs on Bitcoin and
Ethereum mainnet today.

The app: [tacit.finance/bridge](https://tacit.finance/bridge/). The rules: [`SPEC.md` §6](../SPEC.md#6-reflection-and-the-bridge).

## Reflection

Each chain keeps a proven copy of the other's Tacit state. Bitcoin's blocks, once 24 deep, are folded
into proven roots; Ethereum's finalized blocks are verified by a light client; both go into one proof,
which the pool on Ethereum verifies. Nobody signs it, and anyone can make it.

## Burn, prove, mint

Every bridge is three moves:

| | Bitcoin → Ethereum | Ethereum → Bitcoin |
| --- | --- | --- |
| **Burn** | The note is burned on Bitcoin. | The note is burned in the pool, and the cross-out is recorded in its storage. |
| **Prove** | Once 24 blocks deep, the burn is folded into Bitcoin's proof, and the pool verifies it. | Once Ethereum finalizes it, the cross-out is proven inside Bitcoin's proof. |
| **Mint** | The pool mints a fresh note of the same value, privately, once per burn. | A Bitcoin transaction mints a fresh note of the same value, once, as a proven member of the cross-outs. |

The amount is not published on either chain. Whoever makes the mint's proof sees it, and today that is
Tacit's prover.

## One format, two chains

A Tacit note is a Pedersen commitment `C = v·H + r·G` on secp256k1, the curve both chains already use. On
Bitcoin it is an output of a Taproot envelope, with a kernel signature and range proof; in the pool on
Ethereum it is a leaf of the note tree. A bridge burns a note on one chain and mints a fresh one of the same
value on the other, keeping `v` and picking a new `r`, with a proof that nothing was added or lost.

## Bitcoin → Ethereum

1. **Headers, by work.** `BitcoinLightRelay`, a permissionless relay on Ethereum, checks every Bitcoin
   header's proof of work and follows the heaviest chain. Anyone can submit headers.
2. **Every envelope folded.** The Bitcoin reflection program
   ([`reflect.rs`](../contracts/sp1/confidential/src/reflect.rs)) re-hashes each block to its Merkle root,
   checks the witness commitment, and folds every Tacit envelope in it: transfers, trades, AMM and farm
   ops, bridge burns, cBTC locks.
3. **One proof.** SP1 proves the fold. The pool accepts it only if its tip is an ancestor of the relay's
   tip buried at least 24 blocks deep, and it continues the digest the pool already holds.
4. **Checked by the pool.** `attestBitcoinStateProven` verifies the proof on-chain against
   `BITCOIN_RELAY_VKEY`. A proven burn is then minted into the pool once, keyed by its `burn_id`.

TAC the reflection follows is burned in one Bitcoin transaction. TAC it has not followed (a history that runs
through transfers from before reflection began) goes in two: a move to a burn address, then a burn whose
provenance, every transfer back to TAC's etch, is verified in the same proof (`fold_burn_deposit`). The proof
takes up to 256 transfers, the move among them.

## Ethereum → Bitcoin

1. **Finality, signed.** The Ethereum reflection program
   ([`eth-reflection`](../contracts/sp1/eth-reflection/src/main.rs)) is a light client built on sp1-helios.
   It checks the sync committee's signatures over finalized blocks, chained period to period from a pinned
   anchor, and binds to Ethereum mainnet's genesis validators root so no other chain's proof passes.
2. **The pool's storage.** Storage proofs against the finalized execution state root read the pool's
   cross-outs (`crossOutCommitment`), the Bitcoin notes it consumed, and its `EthCallOutbox` messages.
3. **Inside Bitcoin's proof.** The Bitcoin reflection program verifies the Ethereum proof recursively, so
   one proof, checked by the pool, carries both chains.
4. **Folded on Bitcoin.** A `T_CROSSOUT_MINT` re-mints a crossed-out note on Bitcoin only if its claim is
   proven a member of the cross-out set, and only once.

## Who checks what

| Hop | Checked by |
| --- | --- |
| Bitcoin's history | Proof of work, on Ethereum, by a permissionless relay. A reorg deeper than the confirmation depth halts reflection rather than rewriting it. |
| Ethereum's finality | The sync committee's signatures, inside the proof. |
| Every state change | An immutable pool contract, against pinned verifying keys ([`DEPLOYMENTS.md`](./DEPLOYMENTS.md#verification-anchors)). |
| Bitcoin's side | The rules in `SPEC.md`: every indexer that runs them over the same chain reaches the same state, and the reflection proves that state. |
| The programs | Each rebuilds byte for byte from source and is pinned by SHA-256 to its key ([`REPRODUCIBLE-BUILDS.md`](./REPRODUCIBLE-BUILDS.md)). |

Reflection advances when someone runs the provers. The reference relayer does, and anyone else can.

## Run it yourself

Tacit's services keep reflection current, and anyone can run it. Every step is an on-chain call that needs
no permission, and you pay only the network fee:

1. **Send the headers.** `BitcoinLightRelay.advanceTip(headers)` takes Bitcoin's block headers and checks
   each one's proof of work, so only real blocks are accepted.
2. **Make the proof.** Prove the batch the API holds open (below) with `bitcoin_prove` and your own
   account on Succinct's prover network. Everyone runs the same program on the same public inputs.
3. **Submit it.** `attestBitcoinStateProven(publicValues, proof)` accepts any valid proof over the pool's
   current state, from any wallet. Then `POST /reflection/landed`, and the API adopts the batch.

[Community ops](https://tacit.finance/weld/keeper/) does the first and the last from your own wallet, and
[`tools/community-runner.mjs`](../tools/community-runner.mjs) does them on a loop from your own machine
([COMMUNITY-OPS.md](./COMMUNITY-OPS.md)). To
check the deployment itself, run [`tools/verify-live.mjs`](./VERIFY-LIVE.md) and rebuild the programs from
source ([`REPRODUCIBLE-BUILDS.md`](./REPRODUCIBLE-BUILDS.md)).

### The open batch

The API (`https://api.tacit.finance`) holds open the batch it last assembled for Tacit's relay, byte for byte.
A landed copy of it is a batch the API already knows, so Tacit's relay goes on from it. These routes are public
and CORS-open.

| route | |
|---|---|
| `GET /reflection/open?network=mainnet` | `{ pool, job: { jobId, priorDigest, attestedTo, from, blocks, modeB, ethContentHash, bytes, at } \| null }`. Worth proving while the pool's `attestedReflectionDigest()` equals `priorDigest`. |
| `GET /reflection/open/job?network=mainnet&jobId=` | The batch (tens of MB); its `input` is the prover input. Three per caller, then one every five minutes. |
| `GET /reflection/eth-state/proof?network=mainnet&contentHash=` | For a batch with `modeB: 1`, the Ethereum proof it verifies inside (`ethCompressedProofB64`). |
| `POST /reflection/landed` | `{ network }` → `{ adopted, attestedTo }`. The API reads the pool's digest three blocks back from two endpoints and adopts only a batch it assembled. |
| `GET /reflection/burndep-list?network=mainnet` | The burns whose provenance bundles are registered for the reflection to fold. |

`bitcoin_prove` is the Linux x86-64 build in the `prover-bins` release that
[`worker-relay/Dockerfile`](../worker-relay/Dockerfile) names, pinned in `worker-relay/prover/bin/SHA256SUMS`.
Fund its account as in [`OPEN-RELAYER.md`](./OPEN-RELAYER.md#proving-with-your-own-prover-account).
`REFLECT_GAS_LIMIT` caps the request; the network holds that cap's cost from the credit while it proves.

```sh
API=https://api.tacit.finance POOL=0x000000000Ed1eabD231Be41d93b719056F7febFC
J=$(curl -s "$API/reflection/open?network=mainnet" | jq .job)
cast call $POOL 'attestedReflectionDigest()(bytes32)' --rpc-url $RPC_URL    # must equal .priorDigest
curl -s "$API/reflection/open/job?network=mainnet&jobId=$(jq -r .jobId <<<"$J")" | jq .input > reflection_input.json
mkdir -p out
[ "$(jq .modeB <<<"$J")" = 1 ] && curl -s \
  "$API/reflection/eth-state/proof?network=mainnet&contentHash=$(jq -r .ethContentHash <<<"$J")" \
  | jq -r .ethCompressedProofB64 | base64 -d > out/eth_compressed.bin    # Mode-B only
PROOF_MODE=groth16 REFLECT_FIXTURE=reflection_input.json PROVER_OUT=out SP1_PROVER=network \
  NETWORK_PRIVATE_KEY=0x… NETWORK_RPC_URL=https://rpc.mainnet.succinct.xyz REFLECT_GAS_LIMIT=20000000000 \
  worker-relay/prover/bin/bitcoin_prove
cast send $POOL 'attestBitcoinStateProven(bytes,bytes)' 0x$(cat out/bitcoin_pv.hex) \
  0x$(cat out/bitcoin_proof_bytes.hex) --rpc-url $RPC_URL --private-key 0x…
curl -s -X POST "$API/reflection/landed" -H 'content-type: application/json' -d '{"network":"mainnet"}'
```

If another prover lands the same batch first, the pool's digest moves and your send fails its simulation.

## What you trust

Bitcoin's proof of work, Ethereum's validators (through its sync committee), and a proof system whose
pinned verifying keys anyone can rebuild from source. No signer set is in the path.

## How long it takes

Bitcoin → Ethereum waits for 24 Bitcoin confirmations (about four hours) and then the next proof, which
lands on Ethereum about every half hour. Ethereum → Bitcoin waits for Ethereum to finalize (about 13
minutes), then for the next proof to cover the burn, then for the Bitcoin step to confirm: a few hours in
all. A two-step TAC bridge waits for the proof after the move and after the burn, usually within a day.
[tacit.finance/bridge](https://tacit.finance/bridge/) shows the live cadence and follows every bridge a
browser has under way.

## The assets

| Asset | To Ethereum | To Bitcoin |
| --- | --- | --- |
| TAC | Burn on Bitcoin, minted privately in the pool once proven | Cross-out from the pool, minted on Bitcoin once proven |
| tETH | Burn on Bitcoin, minted back in the pool once proven | Cross-out from the pool |
| cBTC | Lock BTC at your own key's output, with a wstETH bond behind it; the pool mints cBTC 1:1 once the lock is proven. Borrow cUSD against it. | Will be burned on Bitcoin to redeem a lock |
| USDT | Burn on Bitcoin, minted back in the pool once proven | Cross-out from the pool, from private USDT (cUSDT) |

USDT is an Ethereum token the pool holds in escrow, so it keeps its six decimals and has no Bitcoin etch: it crosses under the id of its registration
in the pool, a hash of the chain and the token that no Bitcoin etch can produce, so the only USDT notes on Bitcoin are ones a cross-out made, each backed
by the USDT still in the pool's escrow. The pool's registry refuses to give an escrowed token a Bitcoin-side id of its own, and does not need to: a note
that comes back names the same id and resolves to the escrow directly. The USDT in a wallet is made private in the pool first (Permit2: one approval for
exactly the amount and one signature), and is taken out again to an Ethereum address once it is back.

### Limits and costs, while the bridge is new

| | To Bitcoin | Back from Bitcoin |
| --- | --- | --- |
| TAC | 20 to 1,000 TAC a bridge | up to 1,000 TAC, a note goes whole |
| tETH | 0.001 to 0.5 tETH a bridge | up to 0.5 tETH, a note goes whole |
| USDT | 2 to 100 USDT a bridge | up to 100 USDT, a note goes whole |

A TAC note going back in two steps carries up to 255 transfers of history.

| What a bridge costs | To Bitcoin | Back from Bitcoin |
| --- | --- | --- |
| Relay fee | Taken out of the note: the relay's floor for the asset at today's gas (about 0.0005 tETH, 4 TAC). The note must be worth more than it. | None: Tacit covers the Ethereum mint for now |
| Bitcoin fee | About 900 to 1,200 sats at 1 to 2 sat/vB (a 180 vB reveal, a 154 vB commit, and the 546-sat output the note sits on), paid from the key's own Bitcoin address, which needs one free coin of about twice that when the Bitcoin step is sent, a few hours after the burn. A bridge can start without it: the app asks for the sats when the step is due, and the burn waits until they are there | About 1,000 sats at 1 to 2 sat/vB (two transactions, each at least 500), paid from the same address |

[tacit.finance/bridge](https://tacit.finance/bridge/) shows what each way costs at the live rates. A USDT bridge must exceed its relay fee, which follows gas (about 3 USDT at 1.7 gwei, under 1 when gas is cheap; the way back is free, and a withdraw pays it again, about 2.5 USDT at 1.7 gwei). Its
Bitcoin steps are paid separately in sats (about 1,000 to 1,500 each, around a dollar). So the least that crosses moves with gas: 2 USDT is the form's floor, and at today's gas 5 is what gets through, arriving as about 2. The limits are in
[`crossout-ux.js`](../dapp/crossout-ux.js) and [`burndep-ux.js`](../dapp/burndep-ux.js); `tests/bridge-track.test.mjs`
holds the page's copy of them, and of the sizes behind the costs, to those files.

### In the app

The Private ETH sheet's Bitcoin tab (`#private/bitcoin`) has the two ways side by side: **To Bitcoin**
(`#private/bitcoin/out`: the amount, the receipt, the bridges on their way) and **Back to Ethereum**
(`#private/bitcoin/back`: the notes the key holds on Bitcoin, the returns on their way, and a button to bring a
note back). It opens on the side the key has something to do on. The Private ETH balance carries a line for what the
key holds on Bitcoin and what is on its way there, and the same figures show on the dashboard and on the tETH page.
A note comes back whole, so bridge in the amounts you will want back.

[tacit.finance/bridge](https://tacit.finance/bridge/) does the same for the way to Bitcoin once the Tacit key is opened
there (nothing of the key or the wallet library is loaded until it is asked for): for TAC and tETH it takes the amount,
shows the receipt (what arrives, the relay's fee, the Bitcoin fee, the coin the Bitcoin step needs), asks for the
acknowledgement that a burn cannot be undone, and has the relay prove the burn, cutting a note to the exact amount
first when none fits. It also moves every bridge it lists on while the page is open, makes the presses a bridge row
waits on (burn, mint, move back, recover, check again, cancel, send again, sign again), and looks for bridges the
browser has no record of from the key's own Bitcoin address, or from the burn's Ethereum transaction and the amount.
For TAC it also starts a bridge from Bitcoin to Ethereum: it lists the TAC at the key's Bitcoin address with why a note
cannot go, checks the one picked and prices it against the coins the key has free for fees, asks for the same
acknowledgement, and sends the burn (one Bitcoin transaction) or, for a note the reflection does not yet track, the move
that comes first; a note in an older form is first sent to the key's own address, and a note over 1,000 TAC is split.
With several notes it also offers Merge notes (the tracked notes packed within the limit, each pack sent to the key's own
address in one transaction) and Bridge all (the older notes sent first, a burn for each tracked note, a move then a burn for
a note the proof does not track yet), planned by the same rules as the front page, with the fee quoted first and, for Bridge
all, the same acknowledgement. A note sent first or merged is bridged from this page once it has confirmed and Bitcoin's proof
has seen it (the front page lists it under Getting ready too). Bridging a note for the holder when it is ready, minting to
someone else's address or as public TAC, proving a burn or a mint yourself, and paying the mint from a wallet are on the
front page; a press the relay will not take links there.

USDT has a sheet of its own (`#usdt`) with three tabs: **Make private** (USDT from the wallet into the pool), **Withdraw** (private USDT out to the wallet) and
**Bitcoin** (`#usdt/bitcoin/out`, `#usdt/bitcoin/back`: the bridge forms, as for cUSD and cBTC). The front page's Bridge tab takes USDT from the wallet, making it
private first when the key holds too little, and brings it back from Bitcoin.

### Following a bridge

Every bridge is journaled in the browser that started it, and the Bitcoin step needs the key, so a bridge can be left
and come back to: the app moves it on whenever it is open with the key, and so does the bridge page once the key is open
there (the engines hold a lease on each bridge they move, so two tabs never move one at once).
[tacit.finance/bridge](https://tacit.finance/bridge/) lists each bridge with what it waits on, and names a step as ready as soon as the chains say so (the proof has
reached its burn), whether or not the app has been open since. A tab left open there puts the count of bridges that
need their holder in its title, and can send a browser notification when one does, or when one arrives (off until
asked for).

## On mainnet

The ERC-20 supply of TAC (~2.5M) was all minted by the pool from TAC proven to have left Bitcoin. TAC has
made the whole round trip, each leg a settled transaction:

1. Out of the pool: [`0xc7bfc7ce…3c29a8f`](https://etherscan.io/tx/0xc7bfc7cec938e59c5d256d1c44c2aea5269eb7c237ac018878f21b2a93c29a8f)
2. Minted on Bitcoin: [`aaa68792…97bcf2`](https://mempool.space/tx/aaa687924435ef64f056aa83beb7fabef4f57087f315655b52c596f83897bcf2)
3. Burned on Bitcoin: [`7320b6b6…36b0fbb`](https://mempool.space/tx/7320b6b654726ba99489bcf47f3d31dcf8a87040241def827b5fccd8836b0fbb)
4. Back in the pool, as a fresh note: [`0f0793f6…006465bb`](https://etherscan.io/tx/0x0f0793f61e57a0eb40ef551ef516e9a33ba0f270343abedf4ea014aa006465bb)

## Next: covenants

When Bitcoin can enforce where an output is spent (CTV, `OP_CAT`, `OP_CHECKSIGFROMSTACK` or an
equivalent), a cBTC lock becomes a vault that only a redemption opens, minted with no bond behind it.
The bytes are already reserved ([`SPEC.md` §10](../SPEC.md#10-extensions-and-covenant-placeholders)).
