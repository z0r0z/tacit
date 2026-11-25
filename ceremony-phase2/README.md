# Tacit Praxis ceremony: Phase 2 tool

The Tacit Praxis ceremony adds new contributions to the public Groth16 Phase-2 setup of **SP1 v6.1.0's wrapper
circuit** (the one circuit that checks an SP1 proof of any program), continuing from Succinct's last file, `phase2-17`.
Phase 1 is the Hermez / Perpetual Powers of Tau file that Succinct's setup used.

**What Praxis is.** Praxis is a practical witness encryption scheme (Tse, Vanjani and Vesely, ePrint 2026/2971). Witness encryption
locks a message to a statement, so that anyone who holds a proof of that statement can unlock it, and no one else can. Praxis locks
to a Groth16 verifier on BN254, which can express any statement a zero-knowledge proof can, so one key serves every statement.
Its ciphertext is 7.88 GiB at 100-bit security. The verifier has to be set up honestly, and that setup is what this ceremony produces.

The ceremony produces a **new key** for that circuit (a new delta). It does not change Succinct's deployed SP1 verifier
(`VERIFIER_HASH 0x4388a21c…`) or its key, and does not add to the setup that verifier relies on. The new key is the
setup for future Tacit Praxis work, which is in progress and has not been reviewed, and for other Groth16 verifiers of
this circuit. Nothing rests on it today.

The key is sound only if all three hold:

1. at least one of the first 54 contributors to the Perpetual Powers of Tau (Phase 1) was honest;
2. at least one Phase 2 contributor was honest: one of Succinct's 18 contributions, or one here;
3. the starting files (the Phase 1 commons, the initial Phase 2 file and the evaluations) were derived correctly from
   Phase 1 and the circuit. They were re-derived from `powersOfTau28_hez_final_24.ptau` and the circuit and match
   Succinct's files byte for byte, with the rest of the chain up to the key on Ethereum:
   [genesis/RESULT.md](genesis/RESULT.md), and [genesis/reproduce.sh](genesis/reproduce.sh) to run it yourself.

The link-by-link checks below cover (2) from `phase2-17` onward. Checking files cannot show (1), or that one of Succinct's 18
contributors was honest.

What a Tacit Praxis ciphertext will encrypt to (the five public inputs, the gate program, the pinned decryptor stack)
is fixed in [STATEMENT.md](STATEMENT.md).

This tool reads and writes the same files as Succinct's
[semaphore-gnark-11](https://github.com/succinctlabs/semaphore-gnark-11), on the same gnark (`github.com/p4u/gnark`
at `cd7874155e26`).

## Contribute

You need about 16 GB of RAM, about 2.2 GB of free disk, and to download and upload about 1 GB (each file is
1,040,779,531 bytes). Either download a release binary (built with Go 1.27.4; check it against `SHA256SUMS`) or build
the tool yourself (Go 1.24 or later):

```sh
# a release binary, for your computer (darwin-arm64, darwin-amd64, linux-amd64, linux-arm64, windows-amd64.exe)
curl -fLO https://github.com/z0r0z/tacit/releases/download/ceremony-v1.0.0/tacit-ceremony-darwin-arm64
chmod +x tacit-ceremony-darwin-arm64
./tacit-ceremony-darwin-arm64 contribute --coordinator <coordinator URL> --name "<your name>" --handle @you

# or from source
git clone https://github.com/z0r0z/tacit && cd tacit/ceremony-phase2
go build -o tacit-ceremony ./cmd/tacit-ceremony
./tacit-ceremony contribute --coordinator <coordinator URL> --name "<your name>" --handle @you
```

`<coordinator URL>` is on the ceremony's page, https://tacit.finance/praxis/ (a 0x address as the handle is where the ceremony's
points go).

Leave it running. It:

- joins the queue and polls the coordinator to keep the place (a place that stops polling for a minute is given to
  the next person; Ctrl-C gives it up and deletes the tool's files);
- claims the slot when it is your turn (within 3 minutes; the slot then lasts at most 2 hours, and must keep moving:
  the head's download starts within 10 minutes and is complete within 75, and the upload starts within 105, so a
  place cannot be held without working on it);
- downloads the head, resuming after a dropped connection, and checks its SHA-256;
- adds your contribution with fresh randomness (dropped when the program exits: run it on a machine you trust, ideally
  with no swap) and prints your contribution hash;
- uploads it, retrying a dropped connection while the slot lasts;
- checks the receipt: signed by the pinned coordinator key (`--coordinator-key`, default
  `c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7`), for your contribution hash, built on the head you
  downloaded; then saves it as `receipt-<n>.json` and prints a template for your attestation.

Names and handles are self-declared: the coordinator does not check them. Your attestation (see
[attestations/](attestations/)) is what ties a contribution to you.

### Windows (PowerShell)

Install Go from <https://go.dev/dl/> and Git from <https://git-scm.com/download/win>, then:

```powershell
git clone https://github.com/z0r0z/tacit
cd tacit\ceremony-phase2
go build -o tacit-ceremony.exe .\cmd\tacit-ceremony
.\tacit-ceremony.exe contribute --coordinator <coordinator URL> --name "<your name>" --handle "@you"
```

`Get-FileHash -Algorithm SHA256 <file>` prints a file's SHA-256 where the steps below use `shasum -a 256`.

### Offline

To contribute on a machine with no network: download the head, contribute there, and upload from a connected machine.
The upload joins the queue and is accepted only if the head is still the file you built on, so do this when the queue
is quiet.

```sh
curl -s <coordinator URL>/api/head                         # {"index": N, "sha256": ..., "url": "/f/phase2-N", ...}
curl -fO <coordinator URL>/f/phase2-N && shasum -a 256 phase2-N
./tacit-ceremony contribute-file phase2-N phase2-N+1       # on the offline machine; prints the contribution hash
./tacit-ceremony upload --coordinator <coordinator URL> --name "<your name>" --handle @you phase2-N phase2-N+1
```

## Check

```sh
./tacit-ceremony verify <phase2-N> <phase2-N+1>           # one contribution
./tacit-ceremony verify-chain <dir> 17 <head>             # every contribution from Succinct's last file
./tacit-ceremony solidity <groth16_vk.bin> [out.sol]      # a key's Solidity verifier, to compare with a deployed one
```

Every accepted file is also copied to a second store (Filebase, which pins it on IPFS); the copy is made only for
files whose receipts are signed by the coordinator key and chain from `phase2-17`. The list, with each file's IPFS CID,
is at `https://tacit-praxis-ceremony.onrender.com/api/mirror`. Any copy checks against the SHA-256s in the transcript.

Each contribution must carry the hash of the file before it (its challenge); a file without one is refused. Each file
must be exactly the size its layout accounts for, checked before it is read.

## Fixed values

| | |
|---|---|
| Circuit (`groth16_circuit.bin`, SP1 v6.1.0) | sha256 `d6a66be2702206e2b1a20bebf7096142864feac9e399a309e5e6e00353264cbc` |
| Starting file (`phase2-17`, Succinct's last) | sha256 `bf6f7799c77a90009ae356fd0d3a69a91cf153825e6762ce344fe804cf5db2df` |
| Coordinator key (ed25519) | `c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7` |
| Phase 1 seal | the randomness of drand round 1000 on the League of Entropy default chain (`8990e7a9…51b2ce`), as in Succinct's transcript: `a40d3e0e7e3c71f28b7da2fd339f47f0bcf10910309f5253d7c323ec8cea3212`, a constant in `drand.go` whose signature `drand_test.go` checks |
| Phase 2 seal | `SHA-256("tacit-praxis-beacon-v1" ‖ block hash ‖ quicknet randomness)` for the first Bitcoin block mined after the close is announced (with the final head's hash) and the first drand quicknet round after that block's timestamp |

For the Phase 2 seal, the block hash is the 32 bytes of the hash as block explorers and `bitcoin-cli getblockhash`
print it (display order, leading zeros first). The quicknet round is from chain
`52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`; its BLS signature is checked against the pinned
public key before its randomness (SHA-256 of the signature) is used.

```sh
./tacit-ceremony beacon <block hash> <quicknet round>                       # fetches the round from api.drand.sh
./tacit-ceremony beacon --signature <hex> <block hash> <quicknet round>     # offline, from the round's signature
./tacit-ceremony seal <phase1> <head> <evals> <beacon hex> <out dir>        # the keys and their Solidity verifier
```

## Coordinator

```sh
./tacit-ceremony init <dir> <phase2-17> 17 "Tacit Praxis ceremony"
./tacit-ceremony serve [--heartbeat 60s] [--claim-window 3m] [--slot-cap 2h] [--queue-cap 100] [--per-ip 1] \
    [--client-ip-header X-Forwarded-For --trusted-proxies 10.0.0.0/8] [--admin 127.0.0.1:8081] <dir> :8080
./tacit-ceremony queue                     # on the coordinator's machine: every place in the queue
./tacit-ceremony kick <position | token prefix>
./tacit-ceremony ban <prefix | address>      # refuse new places from a prefix and drop the ones it holds
./tacit-ceremony close                     # no more contributions (or close --dir <dir> while serve is stopped)
```

`<dir>` holds `state.json` (the chain and its receipts), `queue.json` (the queue, so it survives a restart),
`coordinator.key` and the files. One place per client address (an IPv6 /48); behind a proxy, the address comes from
`--client-ip-header`, believed only from `--trusted-proxies`. The operator's endpoints listen on a loopback address only.

API (the token goes in the `X-Ceremony-Token` header, never the URL): `GET /api/head`, `GET /f/phase2-<n>` (byte
ranges), `POST /api/join`, `GET /api/slot` (poll), `POST /api/claim`, `PUT /api/upload` (exactly the head's size),
`DELETE /api/leave`, `GET /api/transcript`. A join must be sent as `application/json`. Anyone may download the
files, a couple of connections per address at a time; the slot holder's download (sent with its token) is never limited.

### Moving or recovering the coordinator

Everything a coordinator needs is public except its key: every accepted file and the transcript (which is `state.json`)
are copied to the mirror as they are accepted. To bring the chain up on a new machine:

1. Fetch `transcript.json` and every `phase2-<n>` from the mirror (S3 bucket `tacit-praxis-ceremony` at Filebase, or by
   each file's IPFS CID from `/api/mirror`), and check each file's SHA-256 against the transcript.
2. Put the files in `<dir>`, save the transcript as `<dir>/state.json`, and restore `<dir>/coordinator.key` (64 bytes,
   mode 0600) from the operator's offline copy. `serve` refuses to start if the key does not match `state.json`.
3. Run `./tacit-ceremony verify-chain <dir> 17 <head>`, then `serve` as above. The queue starts empty; contributors
   who were waiting join again.
4. Point the HTTPS window (`COORDINATOR_URL` of the proxy) and the page at the new address.

Contributors' clients pin the coordinator key, so the chain continues under the same key. If the key itself were lost,
the chain would continue from the same head under a new key, published here and on the page; receipts already issued
stay checkable with the old key.

## Release binaries

```sh
./release.sh            # dist/tacit-ceremony-{darwin-arm64,darwin-amd64,linux-amd64,linux-arm64,windows-amd64.exe} + SHA256SUMS
```

Built with Go 1.27.4, `CGO_ENABLED=0`, `-trimpath`, from a clean tree, so anyone can rebuild the same commit and get
the same SHA-256s. `tacit-ceremony version` prints the commit and Go version a binary was built from.

## Credit

Succinct, who organized SP1's v6.1.0 Groth16 setup, and its 18 Phase 2 contributions (`phase2-0` to `phase2-17`;
L2BEAT's ZK catalog lists 18 participants from Etherealize, Polygon, OP Labs, Alpen Labs, Offchain Labs, Succinct,
Coinbase and Across Protocol); the Perpetual Powers of Tau and Hermez; Worldcoin and the zkbnb-setup authors; gnark.
Praxis (Tse, Vanjani, Vesely, ePrint 2026/2971) is a witness encryption scheme that needs an honest setup of the
verifier it encrypts to; it needs no setup of its own and its authors are not part of this ceremony.
