# Signet end-to-end test: readiness and execution plan

## Current readiness result: blocked before funding

The Bitcoin swap simulation and reflection/key-path unit test pass, but they are not a live Signet test. Inspection of upstream `dapp/confidential-deployments.js` shows a `signet` entry that points to Sepolia (chain ID 11155111) and has a pool address, but its confidential asset list is built with `cTAC.assetId: null`. The upstream `btcswap-desk/config.example.json` is explicitly `mainnet` and contains the mainnet TAC asset ID and mainnet pool address. Those values must not be reused for Signet.

A real test must not proceed until the maintainers confirm the correct Signet Bitcoin TAC asset ID, matching Sepolia pool asset ID, deployed pool address, relay/API support, and supported Esplora Signet endpoints. Guessing or copying mainnet values would invalidate the test and risk funds.

## Required test environment

Use two independent test wallets (holder and desk), never the same key:

- Holder wallet: owns a valid Signet TAC note whose lineage is intentionally not bridgeable under the current reflection rule.
- Desk wallet: owns enough Signet TAC notes whose lineage is verified as exactly `tracked`, plus confirmed Signet BTC UTXOs for fees.
- Sepolia account / pool deployment: the matching TAC pool and reflection contracts must be deployed and available.
- Public Signet Esplora endpoints with transaction broadcast/read support.
- A throwaway local config with `network: "signet"`, the maintainer-confirmed asset ID and pool address, Signet Esplora bases, conservative amount limits, explicit fee, and short test-only data directory.

Do not commit wallet keys, RPC credentials, funded wallet dumps, or live swap records. Set keys only in the local process environment. Do not paste private keys or seed phrases into chat.

## Required end-to-end assertions

1. **Preflight:** assert the selected Bitcoin network is Signet and EVM chain ID is Sepolia; assert configured asset ID and pool address are the maintainer-confirmed Signet values; reject any config containing the known mainnet pool or mainnet TAC asset ID.
2. **Input lock:** holder locks the stuck note. The desk independently resolves the note from chain data, confirms it is valid TAC and not already spent/consumed cross-lane, and accepts the offer.
3. **Desk payment:** desk selects only notes whose tracking result is exactly `tracked`; the desk's lock amount equals quote output after the published fee.
4. **Holder claim:** holder verifies the desk lock from chain data and claims it by the MuSig2/adaptor key path.
5. **Desk claim:** desk extracts the adaptor secret from the confirmed holder claim and takes the holder's lock.
6. **Bridge eligibility:** verify the holder's received note is tracked through the Signet/Sepolia reflection view and can be presented to the existing bridge's note/lineage validation. Do not claim a completed mint unless a real proof is generated and settled on the test deployment.
7. **Safety paths:** test insufficient inventory, unknown/unread tracking, holder timeout/refund, desk timeout/refund, restart during an open swap, and a reorg or explorer disagreement without advancing unsafe phases.

## Stop conditions

Stop before broadcasting if any of these is true:

- Signet TAC asset ID or pool address is not confirmed by maintainers.
- The TAC asset is absent or not marked/live in the Signet deployment configuration.
- The holder input cannot be independently classified as stuck.
- Any desk inventory note is `new`, `bound`, `untracked`, unread, or otherwise not exactly `tracked`.
- The holder's lock does not have enough remaining CSV margin for the desk lock and claim.
- The desk cannot show enough tracked inventory and fee funding.

## What can be said today

The offline cryptographic/chain simulation and reflection model tests pass in CI. A real Signet end-to-end test has **not** been run. Current deployment metadata does not yet provide a confirmed TAC asset configuration for this path, so funding wallets or broadcasting transactions now would be premature. The next external dependency is maintainer confirmation of the Signet TAC deployment identifiers and a test inventory source; no private key needs to be shared to obtain that information.
