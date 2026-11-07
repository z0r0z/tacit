# Proving the fixture's blocks to Groth16 on a rented GPU

`tacit-block fixture contracts/test/fixtures/tacit-blocks-mainnet.json 1 0x00000000000000000000000000000000000b10c5` writes the chain's
blocks as guest inputs (`FILE.b<i>.stdin`). To make the real proofs the fork test lands (`FILE.b<i>.stdin.groth16`):

1. Rent a 24 GB CUDA box near `sp1-circuits.s3-us-east-2.amazonaws.com` (US east: a far host fetches the 6.2 GB of circuits at 2 MB/s), e.g.
   `vastai create instance <offer> --image nvidia/cuda:12.4.1-devel-ubuntu22.04 --disk 80 --ssh --direct`.
2. `./prove-and-fetch.sh <instance id> <number of blocks>`: waits for the box, uploads `gpu/` and the inputs, builds `tacit-block-gpu`, fetches the
   circuits over 8 connections, proves every block, copies each proof back and checks it, and destroys the box only after every proof is on disk.
3. `cargo prove vkey --elf elf/tacit-block` gives the program's key for `TacitBlocksFork.t.sol`'s `BLOCK_VKEY`.

Any change to the program, the contract's public words or the memo size changes the inputs: regenerate the fixture and prove again.
