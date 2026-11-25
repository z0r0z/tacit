# The start of the chain, reproduced

SP1 v6.1.0's Groth16 setup, from the Hermez Powers of Tau file to the key Succinct's deployed verifier uses, checked on
24 and 25 November 2026. Every value below is a SHA-256 unless it says otherwise. `reproduce.sh` packages the same steps;
the two logs here are the raw output of the runs (`sg11-genesis.log`, `fastp2n-and-seal.log`).

| Step | Result |
|---|---|
| `powersOfTau28_hez_final_24.ptau`, BLAKE2b-512 | `fa404d14…c733`, the value in the snarkjs README |
| Phase 1, converted from it (`sg11 p1i`), against Succinct's `trusted-setup/phase1` | both `6acd8f65…76edb`: match |
| Initial Phase 2 file, derived from Phase 1 and `groth16_circuit.bin` (`d6a66be2…4cbc`), against Succinct's `phase2` | both `948132cc…c759`: match |
| Evaluations, the same derivation, against Succinct's `evals` | both `53373457…4155`: match |
| The 18 contributions, `phase2` → `phase2-0` → … → `phase2-17` | every link verifies; `phase2-17` is `bf6f7799…b2df` |
| Key extracted from `phase2-17` by Succinct's tool (`sg11 key`) | vk `4388a21c…e696`, pk `c3760e0e…a167`: the files Succinct ships |
| Key extracted by this repository's `tacit-ceremony seal`, with Succinct's seal value (drand round 2000) | the same vk and pk, byte for byte |
| `VERIFIER_HASH()` of the SP1 v6.1.0 Groth16 verifier on Ethereum (`0xb69f2584…f4e2`) | `4388a21c…e696`, and all of the verifying key's constants are in its deployed bytecode |

The initial Phase 2 file and the evaluations were derived twice: by Succinct's `sg11 p2n` (one thread through the circuit's
15,972,262 constraints, 22 hours on a 48-core server of 2014) and by this repository's `rehearsal/fastp2n`, which sums each
wire's terms on its own thread (3 hours on 64 threads); both gave the files above. `fastp2n` also equals gnark's own
`Initialize` byte for byte on test circuits (`fastp2n check`).

How the runs were made, so the claim is no wider than the evidence: the steps above were run as separate commands on two
rented servers (Succinct's `sg11` at `6d6ebc3` and this repository's tools), not as one run of `reproduce.sh`; the script
puts the same commands in order, with each comparison made by the script. The seal of this repository's tool wrote the proving
key in gnark's compressed encoding first and was converted to SP1's dump format with `tacit-ceremony pkdump`; `seal` now writes
the dump format itself.

What this does not show: that the Perpetual Powers of Tau's first 54 contributors included an honest one, or that one of
Succinct's 18 Phase 2 contributors was honest. Those are the assumptions the key rests on (see the README), and checking files
cannot settle them.
