# Reproducible guest builds

Recipe material for rebuilding the three pinned SP1 guest ELFs byte for byte. The full procedure,
toolchain details and verification checklist are in [`docs/REPRODUCIBLE-BUILDS.md`](../../../docs/REPRODUCIBLE-BUILDS.md).

| File | Purpose |
| --- | --- |
| `expected.json` | Pinned sha256, program vkey, source commit, build command and Cargo home per ELF, plus the toolchain strings. Mirrors `../confidential/elf-vkey-pin.json`. |
| `build-in-chroot.sh` | Extracts each pinned commit with `git archive` into `/workspace/tacit`, builds it with `cargo prove build ... --locked`, and prints the sha256 and derived vkey next to the pinned values. Meant to run inside a container or chroot; in a bare chroot without `/proc` it creates the toolchain and linker shims it needs. Also checks the pool bytecode for the two vkeys when `RPC_URL` is set. |
| `eth-main-rs-original-build.patch` | One comment line, applied on top of commit `4a425f1d`, needed to reproduce the pinned eth-reflection ELF exactly. Code is unchanged. |

These files are not inputs to any guest build; adding or editing them does not change any ELF or hash.
