# Prebuilt SP1 network-prove binaries

The binaries are not committed; only their `SHA256SUMS` is. The `Dockerfile` fetches every `exec-<op>`, `bitcoin_prove` and
`eth_prove` from the GitHub release named by `PROVER_RELEASE` and checks them against it.

To build them yourself (needs the SP1 toolchain and the guest ELFs):

- `bitcoin_prove` and `eth_prove`: in `contracts/sp1/eth-reflection/prover-host`,
  `cargo build --release --bin bitcoin_prove` (or `--bin eth_prove`). Each embeds its guest ELF with
  `include_bytes!`, pinning the vkey it proves against.
- `exec-<op>`: in `contracts/sp1/confidential/harnesses`, `cargo build --release --bin exec-<op>`
  (sources in `exec-<op>.rs`), with the settle guest ELF embedded.

All are patched to `.network()`. Rotating a guest means bumping `SHA256SUMS`, the release tag and the
on-chain vkey together.
