# Tacit V1 audit bundle — manifest (round 2)

Version-tracked copies of the round-2 audit bundle's orientation docs, kept next to the code they describe.
`PROMPT.md` is the bundle's `README.md` (the neutral audit brief handed to the reviewers).

**Bundle:** `tacit-v1-audit-r2.zip`
- bundle sha256: `1802009863fb545e2e14830a1fb8991f6acd7af56c3496548be312cf5c86c23c`
- file-hash-set sha256: `11de527e3265f6695427c4d2d205aba3d7d389fd7dd83cd8c1e87c8f415b169e`

**Assembled from** the hardening branch (`relay-boundary-reorg-forkchoice`) at the farm-redesign commit.

**In scope (41 files):** the SP1 settle + reflection + cxfer-core guests, the circom circuits, and the V1
immutable Solidity surface — `ConfidentialPool`, `ConfidentialRouter`, `CollateralEngine`, `FarmController`,
the canonical asset/minter/bridged-ERC20 factory, `TacitRelayer`, `BtcCallExecutor`, `ChainlinkEthBtcAdapter`,
and `BitcoinLightRelay` (added this round — the reflection anchor's Bitcoin light client). Plus the design
docs, fixtures (incl. the real-ceremony Groth16 verify vector), and pins.

**Out of scope (excluded):** the legacy denomination-pool mixer — `TacitBridgeMixer`, its `SP1PoolRootVerifier`
guest, and the standalone 5-signal `Groth16Verifier` — plus `ICreateX` (deploy interface) and
`MerkleDistributor` (airdrop). Not part of the V1 confidential surface.

The full applied-fix delta is in `CHANGES-SINCE-LAST-ROUND.md`.
