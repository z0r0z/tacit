# TAC bridge-as-a-service — design sketch

Goal: turn "bridge my native TAC from Bitcoin to Ethereum" from a multi-day, hand-run,
per-note engineering exercise into a repeatable pipeline a user can trigger and forget.

## What's actually expensive vs. what only felt expensive

The earlier working assumption — that each bridge costs $150-500 in mining fees because
the provenance blob (header chain + CXFER DAG) has to ride inside the Bitcoin transaction —
was wrong for gen4. Checked directly against the deployed guest (`reflect.rs:920,935`):
`prov_headers` and the DAG blob are both read via `io::read()`, i.e. SP1 prover stdin, never
placed on-chain. The real completed bridge's burn transaction
(`b49f4016...da13c`) is 906 bytes, paid 821 sats (~2 sat/vB) — an ordinary cheap Bitcoin tx.

So the real cost structure is:

| Step | Cost | Repeatable? |
|---|---|---|
| Burn tx broadcast | ~$1 (normal Bitcoin fee) | Yes, trivially |
| Getting the burn tx *included* | Unknown — needs confirming (see below) | Probably yes, via one relay relationship |
| Provenance DAG walk (Bitcoin side) | Compute + a few hundred esplora calls | Yes, scriptable |
| Header chain fetch (etch → current tip) | Compute + thousands of esplora calls | Yes, scriptable, and *cacheable* across users |
| Bundle submission (`/reflection/burndep`) | Free, but box-token gated | Yes, once the gate is handled server-side |
| Reflection fold + `OP_BRIDGE_MINT` settle | Existing relay infra | Yes, already productized |

**CORRECTED (2026-09-12, later the same day): the "plain broadcast works" claim below does NOT hold
for this pipeline's actual burn shape — re-tested directly and it fails.** The second bridge this
note originally described must have gone through `reflect.rs`'s OTHER fold path — the
"reflected-note bridge-out" branch (`spends.len()==1`, for a note the ordinary reflection scan
ALREADY tracks as live) — not the scan-free/DAG-walk onboarding path this whole design doc is
about. Those two paths need genuinely different transaction shapes: the DAG-walk path hard-requires
(`reflect.rs` ~line 1102-1107, `inputs.first()`) that the burned note's own spend AND the 0x2b
envelope share the SAME vin[0] — there is no way to split them across two inputs for this path. That
forces the ~161-byte envelope into a single non-script witness stack item, and Bitcoin Core's real
relay policy caps such an item at ~80 bytes. Confirmed empirically against three separate nodes
today (blockstream.info, mempool.space, mempool.bitaroo.net — the exact one this note originally
cited) with the identical combined-input shape: all three reject with `-26 bad-witness-nonstandard`.
So for THIS path specifically, plain broadcast does not work, MARA Slipstream (or an equivalent
direct-to-miner submission service) is genuinely required, and that was never solving a
setup-specific problem — see `scratchpad/MODEB-RECIPE.md`'s "RESOLVED: the exact mechanism..."
entry for the full writeup of both paths and why the split-input construction works ONLY for an
already-tracked note.

## Reusable vs. per-user work

**Reusable (do once, cache, reuse for every future TAC bridge):**
- The header chain from the TAC etch (block 948242) to whatever height the reflection has
  reached. This only grows — never shrinks or resets — so a server-side cache that appends
  new headers as they confirm (a simple cron polling the tip) turns "fetch 18,000+ headers"
  into "fetch the ~144/day since we last checked."
- The DAG-walking and bundle-assembly code (`burn-deposit-assembler.js`,
  `burn-deposit-bitcoin.js`, the pattern in `build-burn-witness.mjs`) — already exists,
  already proven against a real completed bridge.
- Any established relay/submission relationship for getting the burn tx included.

**Per-user (genuinely note-specific, can't be cached):**
- That user's own CXFER ancestry back to *some* terminus — either the etch (full walk) or an
  already-tracked `pool_root` member (the `poolMemberships` shortcut, cheaper when available —
  confirmed real in the guest code, though not yet exercised by an actual completed bridge; a
  wallet that's done a cBTC lock or crossOut mint in its own history would qualify, most fresh
  TAC-only wallets won't).
- Their own destination note (blinding, owner key) and the burn tx that spends their specific UTXO.
- Waiting on: 6-block Bitcoin confirmation, reflection catching up to that height, then the
  `OP_BRIDGE_MINT` settle. This is protocol-level latency, not something a pipeline can shrink —
  budget it into UX copy (~1hr+ for confirmation depth alone, more for reflection catch-up
  depending on cadence).

## Sketch: what a "bridge-as-a-service" endpoint looks like

1. **User-facing ask**: wallet key (or a signed intent) + the UTXO(s) to bridge + a destination
   Ethereum-side owner. No header/DAG knowledge required from the user.
2. **Server-side, using the cached header chain**:
   - Walk the user's note back to a terminus (etch or a pool-membership hit) using the existing
     assembler tooling — this is the one step that scales with the *user's* history, not with
     Tacit's.
   - Build the envelope + burn tx, return it for the user to sign (their key never leaves their
     device) or countersign via a relayed-fee flow if that's the desired UX.
   - Broadcast via whatever the confirmed-working submission path is (plain broadcast if the
     inscription-filtering theory turns out to be wrong; otherwise the standing miner
     relationship).
   - Poll for confirmation, then submit the bundle to `/reflection/burndep` server-side (the
     box-token gate is an operational detail the user never sees).
3. **Status surface**: a simple job-status endpoint (burn broadcast → confirmed → reflection
   folded → minted), mirroring the existing `/confidential/status` pattern already used for
   settle jobs elsewhere in the relay. Reuses infrastructure, not a new concept.
4. **Failure modes to design for explicitly** (each is a real, already-encountered failure this
   session or the prior one hit):
   - Wrong nullifier domain on a note that's already crossed out or bridge-deposited (permanent,
     unrecoverable if broadcast — validate client-side *before* ever signing).
   - Vout-0 P2TR shape violations on any mint-adjacent reveal (silent skip, not a revert).
   - Submitting a burndep bundle before the reflection cursor has actually reached the burn's
     height (wasted call, not harmful — just needs a wait/retry loop keyed off `/reflection/dump`
     or the public `attestBitcoinStateProven` calldata, which — worth noting — can be decoded
     without any box-token access at all: the newly-attested height sits in the calldata as a
     plain uint256, confirmed this session by decoding it directly from a public tx).

## Second real bridge, run end-to-end this session — confirms the split holds

Bridged a second, independent 1000-TAC note (same protocol, different UTXO, same hub-wallet
lineage as the first bridge but no shared ancestry beyond the etch) to validate the reusable/
per-user split above wasn't a one-data-point fluke:

| Step | First bridge (prior session) | Second bridge (this session) |
|---|---|---|
| DAG hops to etch | 38 | 33 |
| Header count (etch → attestable tip) | 17,723 | 18,428 (695 more, ~4 days later — confirms the count is real wall-clock-time-dependent, not fixed) |
| Burn tx size / fee | 906 B / 821 sats | 228 vB / 456 sats (plus a 153 vB / 306 sats commit tx — see below) |
| Submission method | MARA Slipstream (off-mempool) | **Plain `POST /tx` to an ordinary public esplora node — worked immediately, no filtering** |

**Confirms the inscription-filtering theory is wrong** (or at least not universal): this bridge's
burn tx uses the identical `OP_FALSE OP_IF...OP_ENDIF` envelope shape and relayed through
`mempool.bitaroo.net` with zero special handling. Drop the "standing miner relationship" item
from the open-items list below — a pipeline can just broadcast normally.

**One structural correction to the sketch above, found while building this one**: the value note
being burned *never needs to move or be re-blinded first*. The envelope always lives in a
fresh, throwaway, single-use commit→reveal pair (exactly the same pattern every ordinary Tacit
CXFER send already uses for its own envelope — see `dapp/tacit.js`'s send-building code,
~line 28124: `envelopeScript = encodeEnvelopeScript(...)`, `p2trSpk = p2trScript(...)`). The burn
tx's vin[0] spends that fresh commit output (revealing the envelope), vin[1] spends the actual
value note completely unchanged, as an ordinary P2WPKH input. No "migrate to a taproot home
first" step, no new blinding to derive, no extra re-blinding risk. This means bridging a fresh
user's P2WPKH-homed note needs exactly two new transactions total (one tiny commit + the burn),
funded from whatever sats the user already has — not three or more.

Both transactions were self-checked via `classifyConfidentialTx` (the same function the
reflection system's own off-chain mirror uses) *before* broadcast — confirmed exact match on
nullifier, assetId, destination leaf, and chain-binding target — and both broadcast txids matched
the locally-computed ones byte-for-byte. This self-check is cheap and should be a hard gate in
any pipeline: never broadcast a burn without it, since a wrong nullifier here permanently strands
the value (spent on Bitcoin, never eligible to re-mint).

## Open items before this is real infrastructure, not a sketch

- ~~Confirm or refute the inscription-filtering theory~~ — done, plain broadcast works.
- Decide who runs the header-chain cache and how it's exposed (a relay-side service the pipeline
  calls internally, most likely — no reason to expose raw headers to end users).
- Decide the box-token story: keep `/reflection/burndep` gated and have the pipeline hold the
  credential server-side (simplest), or open a scoped, rate-limited public path for bundle
  submission (more self-serve, more abuse surface to think through). Still the single remaining
  gated step in an otherwise fully scriptable pipeline as of this session.
- Test a genuinely fresh, never-before-touched wallet (no shared hub-wallet ancestry with any
  prior bridge) to confirm the DAG walk and header-fetch tooling generalize beyond this one
  wallet's transaction history shape.
