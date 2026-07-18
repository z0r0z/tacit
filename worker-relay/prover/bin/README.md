# Prebuilt SP1 network-prove binaries

Drop the CI-built binaries here before building the Render image:

- `bitcoin_prove` — from `contracts/sp1/eth-reflection/prover-host`, `cargo build --release
  --bin bitcoin_prove` (patched to `.network()`; the eth-reflection guest ELF is
  `include_bytes!`'d in, pinning the vkey the pool verifies).
- `exec` — from `contracts/sp1/confidential/harnesses`, `cargo build --release --bin exec`
  (patched to `.network()`; the confidential guest ELF is baked in).

Build these on a machine with the SP1 toolchain + the guest ELFs staged (the GPU box already
does), publish as a release artifact, and place them here so `Dockerfile` `COPY prover/`
picks them up. They are gitignored binaries — do not commit them; fetch in CI.
