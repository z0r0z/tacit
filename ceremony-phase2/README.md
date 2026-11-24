# Tacit Praxis ceremony: Phase 2 tool

The Tacit Praxis ceremony extends the public Groth16 Phase-2 setup of **SP1 v6.1.0's wrapper circuit** (the one circuit
that checks an SP1 proof of any program) with new contributions. Security needs one honest contributor anywhere in the
chain: in Succinct's 18 or in ours. Phase 1 is the Hermez / Perpetual Powers of Tau file that Succinct's setup used.

This tool reads and writes the same files as Succinct's
[semaphore-gnark-11](https://github.com/succinctlabs/semaphore-gnark-11), on the same gnark (`github.com/p4u/gnark`
at `cd7874155e26`), so a contribution here is a contribution to the same chain.

## Contribute

You need Go 1.24 or later, about 16 GB of RAM, and to download and upload about 1 GB.

```sh
git clone https://github.com/z0r0z/tacit && cd tacit/ceremony-phase2
go build -o tacit-ceremony ./cmd/tacit-ceremony
./tacit-ceremony contribute --coordinator <coordinator URL> --name "<your name>" --handle @you
```

It joins the queue, waits for your turn, downloads the current head and checks its SHA-256, adds your contribution
with fresh randomness (dropped when the program exits: run it on a machine you trust, ideally with no swap), uploads
it, and prints a receipt signed by the coordinator. The coordinator checks every contribution against the head before
it is accepted.

Post your receipt's `contribution_hash` publicly. Anyone can check it against the transcript and the files.

## Check

```sh
./tacit-ceremony verify <phase2-N> <phase2-N+1>           # one contribution
./tacit-ceremony verify-chain <dir> 17 <head>             # every contribution from Succinct's last file
```

## Fixed values

| | |
|---|---|
| Circuit (`groth16_circuit.bin`, SP1 v6.1.0) | sha256 `d6a66be2702206e2b1a20bebf7096142864feac9e399a309e5e6e00353264cbc` |
| Starting file (`phase2-17`, Succinct's last) | sha256 `bf6f7799c77a90009ae356fd0d3a69a91cf153825e6762ce344fe804cf5db2df` |
| Phase 1 seal | drand round 1000, as in Succinct's transcript (the files depend on it) |
| Phase 2 seal | a drand round and a Bitcoin block announced before the close: `tacit-ceremony beacon <block hash> <round>` |

## Coordinator

```sh
./tacit-ceremony init <dir> <phase2-17> 17 "Tacit Praxis ceremony"
./tacit-ceremony serve <dir> :8080
```

API: `GET /api/head`, `GET /f/phase2-<n>`, `POST /api/join`, `GET /api/slot`, `PUT /api/upload`, `GET /api/transcript`.

## Credit

Succinct and the contributors to SP1's v6.1.0 setup; the Perpetual Powers of Tau and Hermez; Worldcoin and the
zkbnb-setup authors; gnark. Praxis (Tse, Vanjani, Vesely, ePrint 2026/2971) is a witness encryption scheme that needs an
honest setup of the verifier it encrypts to; it needs no setup of its own and its authors are not part of this ceremony.
