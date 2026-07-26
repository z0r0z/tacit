# Tacit V1 audit bundle — manifest (final round)

Version-tracked copies of the final audit bundle's orientation docs, kept next to the code they describe.
`PROMPT.md` is the bundle's `README.md` (the audit brief handed to the reviewers — this round it asks for a
holistic, from-scratch GO/NO-GO judgment over the whole immutable surface, with published coverage bounds,
intended for publication).

**Bundle:** `tacit-v1-audit-final.zip`
- bundle sha256: `2111e0322d2ce838283d68a89d0c740a16c680021bc4f896db45fcb6befc4f54`

**Assembled from** the fixed source tree after the two review passes on the round-2 bundle (all findings
remediated — see `CHANGES-SINCE-LAST-ROUND.md`). Source surface ≈ 30,524 lines (Rust / Solidity / Circom).

**In scope (41 files):** the SP1 settle + reflection + cxfer-core + eth-reflection guests, the circom circuits,
and the V1 immutable Solidity surface — `ConfidentialPool`, `ConfidentialRouter`, `CollateralEngine`,
`FarmController`, the canonical asset/minter/bridged-ERC20 factory, `TacitRelayer`, `BtcCallExecutor`,
`ChainlinkEthBtcAdapter`, and `BitcoinLightRelay` (the reflection anchor's Bitcoin light client). Plus the
design docs, fixtures (incl. the real-ceremony Groth16 verify vector), and pins.

**Out of scope (excluded):** the legacy denomination-pool mixer — `TacitBridgeMixer`, its `SP1PoolRootVerifier`
guest, and the standalone 5-signal `Groth16Verifier` — plus `ICreateX` (deploy interface) and
`MerkleDistributor` (airdrop). Not part of the V1 confidential surface.

The applied-fix delta since the previous bundle is in `CHANGES-SINCE-LAST-ROUND.md`.
