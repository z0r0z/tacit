# Building sp1-gpu-server for smaller cards

The SDK runs `~/.sp1/bin/sp1-gpu-server` and checks only its `--version`, so a server built from the same sp1 tag with
`lowmem.patch` applied is used in place of the downloaded one. The worker's SDK is sp1 6.3.1, so the server is built from v6.3.1.
sp1-gpu is MIT/Apache-2.0.

The patch makes three settings readable from the environment, each unchanged when unset: `SP1_GPU_MIN_GB` (the memory gate,
default 24, on ceil(VRAM GiB) + 4), `SP1_GPU_ELEMENT_THRESHOLD` (the core shard's element threshold, default 402,653,184, or
301,989,888 at 30 GB and under) and `SP1_GPU_LOG_SHARD_SIZE` (default 24).

On Ubuntu 22.04 with the CUDA 12.8 toolkit (the `nvidia/cuda:12.8.1-devel-ubuntu22.04` image), CMake 3.24 or newer (22.04's is
3.22), Go (sp1's Groth16 library is built from Go), protoc, clang, pkg-config, libssl-dev and the Rust toolchain:

```sh
git clone --depth 1 --branch v6.3.1 https://github.com/succinctlabs/sp1 && cd sp1
git apply /path/to/lowmem.patch
CUDA_ARCHS="86" cargo install --locked --root "$HOME/.sp1-lowmem" --path sp1-gpu/crates/server/   # 80 A100, 86 Ampere (3060/3090/A4000/A5000), 89 Ada (4060 Ti-4090), 120 Blackwell
cp "$HOME/.sp1-lowmem/bin/sp1-gpu-server" "$HOME/.sp1/bin/sp1-gpu-server"
```

Measured 2026-11-06 on an RTX A4000 (16 GB, 16 cores), the worker's BENCH over tests/fixtures/sp1-stdin with
`SP1_GPU_MIN_GB=16 SP1_GPU_ELEMENT_THRESHOLD=134217728`: every op proves to Groth16, at most 15.3 GB of the card in use;
fastlane 152 s cold, 110 s warm; swap 88 s, 81 s; transfer 113 s. An Apple-silicon laptop takes about nine minutes an op.
