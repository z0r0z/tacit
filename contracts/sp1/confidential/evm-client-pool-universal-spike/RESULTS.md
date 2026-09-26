# PLONK / FFLONK spike results (2026-09-26)

Circuit: dapp/circuits/btc-pool/spend.circom (BtcPoolSpend depth=32,2,3), same shape as the live Bitcoin
pool's client-proved relation, ~30k R1CS constraints. Compiled once, shared between systems. ptau: Hermez
pot18 for Groth16/PLONK (pinned), Polygon Hermez `ppot_0080_22` truncated for FFLONK's larger domain
requirement. No new trusted-setup ceremony for either universal system — both reuse the same Hermez lineage
Tacit already pins.

| | Groth16 (baseline, dev key) | PLONK | FFLONK |
|---|---|---|---|
| Setup needs circuit-specific contribution | Yes (this is what a ceremony is for) | No | No |
| Prove time, native node, laptop | ~3 s | 534.6 s (~9 min) | setup alone: 646 s; prove did not finish (aborted, see below) |
| Peak memory, prove | small | 4.25 GB | setup: 11.7 GB peak; prove uses the full 2.1 GB zkey plus working set |
| Proving key (zkey) size | small (per-circuit) | not measured (prove completed) | **2,134,420,008 bytes (2.13 GB)** |
| Domain size | — | 2^19 (524,288 gates) | 2^22-class (larger; `ppot_0080_22`) |

FFLONK's prove step was mid-ROUND-1 when the host session ended; it was not resumed, because the setup
numbers alone are decisive: a 2.1 GB proving key and an 11.7 GB memory peak for *setup* rule out an
in-browser or on-phone prover regardless of what the prove step's own time turns out to be.

## Verdict

Neither PLONK nor FFLONK is usable for "the user proves on their own device for free": PLONK takes ~9
minutes and 4.25 GB of RAM to prove natively on a laptop (worse under wasm in a browser); FFLONK's key is
too large to ship to a client at all. Both are otherwise attractive (no ceremony, and FFLONK's on-chain
verify is reportedly cheap and public-input-count-independent), so they stay a good fit for a
*server/relayer-proved* path if Tacit ever wants one, but not for this pool's client-proving requirement.

Decision: build the EVM client pool on Groth16 with Tacit's own phase-2 ceremony (same coordinator that
already closed the mixer at 2,227 contributions and the AMM circuits at 5,018–13,703), proving the tree
insertion inside the circuit so the contract never hashes on-chain. See
contracts/sp1/confidential/DESIGN-evm-client-pool.md.
