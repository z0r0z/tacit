# What the ceremony's key is for: the statement, the gate program, tracks

This file fixes, before the ceremony closes, what a Tacit Praxis ciphertext encrypts to, so the key's use does not
depend on choices made after its contributors have gone. Version 1. Nothing rests on the key today; the Praxis
encryptor and decryptor are in progress and have not been reviewed.

## The key

The ceremony produces a Groth16 key (BN254) for SP1 v6.1.0's wrapper circuit (`groth16_circuit.bin`, sha256
`d6a66be2…4cbc`), the circuit every SP1 release from v6.1.0 to v6.10.0 uses to end a proof of any program. It differs
from Succinct's key only in delta (and the points that carry it), so:

- a proof made with Succinct's key does not verify under the Tacit key, and the reverse;
- the Tacit key can serve any Groth16 verifier of this circuit, not only Praxis: a Solidity verifier is `tacit-ceremony
  solidity <vk>`. A verifier must accept exactly one of the two keys; one that accepted both would be as weak as the
  weaker setup;
- its soundness rests on Phase 1 (one honest contributor among the Perpetual Powers of Tau's first 54) and on one
  honest Phase 2 contributor among Succinct's 18 and this ceremony's.

Praxis needs no setup of its own (its parameters are derived from public seeds). Whoever held the Groth16 key's
trapdoor could make proofs for any statement, and so open any ciphertext made for the key, without leaving a trace.
That is what the ceremony is for, and why it extends Succinct's 18 contributions rather than replacing them.

## The statement (v1)

The wrapper circuit has five public inputs. A ciphertext fixes all five:

| input | value |
|---|---|
| program vkey hash | the vkey hash of the `praxis-gate` program (below), as published with its ELF |
| public-values digest | SHA-256 of the gate's committed public values: the statement bytes `S` below |
| exit code | 0 |
| vk root | SP1 v6.1.0's recursion vk root `0x002f850e…` (the same in every release v6.1.0 to v6.10.0) |
| proof nonce | the first 16 bytes of `SHA-256("tacit-praxis-nonce-v1" ‖ ciphertext id)`, as four u32 words each read big-endian from 4 bytes (the layout of SP1's own `generate_nonce`) |

The nonce is chosen by the prover (`with_proof_nonce` in the SP1 SDK), so a decryptor can always match it. Binding it to
the ciphertext means a proof that leaks opens only the ciphertext it was made for, not every ciphertext with the same
statement. The ciphertext id is the SHA-256 of the ciphertext's header (its seed and parameters), fixed before the
group elements are computed.

Statement bytes: `S = "tacit-praxis-statement-v1" ‖ u32 kind ‖ u32 len ‖ params`, all integers little-endian. Kinds
are added only by publishing a new version of this file and of the gate program; kind numbers are never reused.

## The gate program

`praxis-gate` is one SP1 program (Rust, built reproducibly with `cargo prove build --docker` at a pinned SP1 version)
that reads `S` and a private witness, checks the witness against `S` according to its kind, and commits `S` as its only
public value. It exits non-zero if the check fails. One program for every kind keeps one vkey hash, so every ciphertext
has the same shape and the decryptor stack is the same for all of them; adding a kind is a new program version and a
new vkey hash, published before any ciphertext uses it.

The first kinds are to be fixed with the program, before it is published. Each is a plain check of public data (for
example, the preimage of a hash, a signature by a public key, or a header chain with a given amount of work).

## The decryptor stack, pinned

Before a ciphertext is made for value, these are published together and pinned on IPFS by CID, so a decryptor can rebuild
everything years later without any of the people who made it:

1. the sealed `groth16_pk.bin` and `groth16_vk.bin` (with the ceremony's final transcript and the beacon inputs);
2. `groth16_circuit.bin` and the SP1 source of the release the decryptor builds with;
3. the `praxis-gate` source, its ELF and its vkey hash;
4. the Praxis encryptor/decryptor source and its parameters (seeds, sizes);
5. a script that proves a statement with the Tacit key (SP1 reads the circuit files from
   `$SP1_GROTH16_CIRCUIT_PATH`; the pk and vk there are swapped for the Tacit ones) and checks the proof with the vk.

## Tracks

The ceremony has one track: the circuit above. The tool can run more (each track is its own chain directory, its own
coordinator key and its own public address; contributors and attestations can list contributions on several), but a
second Phase 2 starts only once a second circuit is frozen and published, with a reason it cannot be served by this
one. A circuit that changes after contributions have started makes those contributions worthless, so no track is opened
for a circuit still being designed.
