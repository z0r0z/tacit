# Prover incremental state — design

The SP1 prover loop currently bails ("incremental pool-tree reconstruction
not implemented") the moment activity advances the verifier's
`poolsHash`/`nullifierSetHash` past empty. For continuous mainnet ops
(multiple proof cycles, each picking up where the prior left off) the
prover host needs to **persist its state between cycles** and **re-feed
it to the guest** as the next proof's `prev_state`.

## State that needs to flow

What the guest reads at the START of a cycle (from `stdin`, in order):

1. **Per-pool prev state:** `(root, next_index, [frontier_0..frontier_{depth-1}])`
   for each denomination. Compact representation of the merkle tree;
   sufficient for the guest to keep inserting at the right position.
2. **Prev `null_set_hash`** + **null count**.
3. **Prev state height**.
4. **UTXO count** (followed by entries later in the stream).
5. **Prev block hash** (after deposit roots + VK + domains, see existing
   stdin order in `contracts/sp1/script/src/main.rs:217-282`).
6. **Nullifier entries** + **UTXO entries** — these are read AFTER the
   block data in the guest (`contracts/sp1/program/src/main.rs:60-78`).
   The host writes them inline at the `null count`/`utxo count` markers.

What the verifier commits + the host can READ on-chain (so it knows the
host's saved state hasn't drifted):

- `currentState.poolsHash` (aggregate `sha256(root_0||root_1||...||root_{n-1})`)
- `currentState.nullifierSetHash`
- `currentState.stateHeight`
- `currentState.lastBlockHash`
- `currentStateCommitment` (top-level commitment binding all of the above
  plus null/utxo counts — `SP1PoolRootVerifier.sol:53`)

What the verifier does NOT commit + the host therefore has to source
itself:

- Per-pool **frontiers** (rightmost filled subtree at each depth)
- Per-pool **next_index** (insertion cursor)
- The **full null set** (entries, not just hash)
- The **full UTXO set** (entries, not just hash)

## Recovery options for the missing data

**Option A — host-side replay from genesis.** Each cycle, the host
re-fetches all blocks from genesis to the current verifier height,
parses every envelope, and applies the same state transitions the guest
would. Pros: no guest changes, no new public values, no redeploy. Cons:
~300 lines of guest-mirror logic in the host (Rust), O(N) work per
cycle so O(N²) total over the chain's life. Acceptable for low-traffic
v1 launch; unsustainable past a few thousand cycles.

**Option B — guest state emission via additional public values.** Add
~20 bytes per pool (frontier hashes) + a length-prefixed list of null
set entries + a length-prefixed list of UTXO entries to the guest's
committed public values, AFTER the existing 461-byte fixed head. The
on-chain verifier only reads the first 461; extra bytes are
SP1-authenticated but ignored by `proveStateTransition`. The host parses
the tail + writes the full state to a file. **Single point of truth,
authenticated by SP1, O(1) host work per cycle.** Cost: guest ELF
changes → new vkey → coordinated redeploy. THIS is the clean fix.

**Option C — hybrid.** Implement A first (no guest changes, ships
immediately), implement B later. The state file format is the same; A
populates it via replay, B populates it via parsing committed bytes.

## Recommended path for v1

**Option B from day one if mainnet redeploy is on the table; Option C
otherwise.** Option A alone is a foot-gun for sustained ops — every
cycle re-fetches the entire chain history.

## State file format

```jsonc
// /workspace/prover-state/state.json
{
  "denominations":      [hex32 × N],
  "pool_roots":         [hex32 × N],
  "pool_next_indices":  [u64    × N],
  "pool_frontiers":     [[hex32 × depth] × N],
  "null_set_hash":      hex32,
  "state_height":       u64,
  "nullifiers":         [hex32 × null_count],
  "utxo_set":           [[hex32_txid, u32_vout, hex33_commit, u64_amount] × utxo_count],
  "last_block_hash":    hex32,
  "state_commitment":   hex32   // re-derived at load; must equal verifier's currentStateCommitment
}
```

`struct ProverState` already exists at
`contracts/sp1/script/src/main.rs:19-31` with this shape;
`load_prover_state`/`save_prover_state` already exist. **The missing
piece is wiring them into the prove path AND producing the data on the
save side.**

## Cycle-start load (the easy half, implemented this session)

```rust
let saved = env::var("STATE_FILE").ok().and_then(|p| load_prover_state(&p));
let prev_state = match (saved, &vstate) {
    (Some(s), Some((ph, nh, h, lb))) if s.matches_verifier(ph, nh, *h, lb) => {
        Source::SavedFile(s)
    }
    _ => Source::FromVerifier  // existing genesis / empty-pools-empty-null path
};
```

The match guard `matches_verifier` checks the saved state's recomputed
`(poolsHash, nullifierSetHash, stateHeight, lastBlockHash)` matches what
the verifier has committed — guarantees the file is in sync with chain
state. If mismatch (file stale, manual edit, etc.) fall back to the
existing reconstruct-from-verifier path.

## Cycle-end save (the work for the next session)

Pick Option A or B (above) and implement the data source. Existing
`save_prover_state` already serializes the struct.

### If Option B:

```rust
// Guest (program/src/main.rs), after the existing io::commit_slice block:
for tree in &trees {
    let frontier = tree.frontier();
    for f in &frontier { io::commit_slice(f); }
    io::commit_slice(&tree.next_index().to_be_bytes());
}
io::commit_slice(&(null_set.count() as u32).to_be_bytes());
for n in null_set.entries_sorted() { io::commit_slice(n); }
io::commit_slice(&(utxo_set.len() as u32).to_be_bytes());
for (txid, vout, commit, amount) in &utxo_set {
    io::commit_slice(txid);
    io::commit_slice(&vout.to_be_bytes());
    io::commit_slice(commit);
    io::commit_slice(&amount.to_be_bytes());
}

// Host (script/src/main.rs), after proof generated + verified:
let pv = proof.public_values.as_slice();
let mut p = 461;  // skip the on-chain-consumed head
let state = parse_prover_state_tail(pv, &mut p, nd, depth);
save_prover_state(&state_file_path, &state);
```

This is the **smallest delta** that makes incremental proving real. The
guest hardening + redeploy is the cost; in exchange every prove cycle
after the first is O(1) host work + state stays in lockstep with SP1.

## Other notes

- The save side MUST be atomic. A torn write at cycle N+1 with a partial
  state file means cycle N+2 reads garbage. Write to `.tmp` + rename.
- Reorgs interact with this: a reorg invalidates anything saved at the
  orphaned tip. The load path's `matches_verifier` guard catches it
  (verifier state changes on a re-prove) and forces fallback. Combined
  with the `FINALITY_WINDOW=6` in the verifier (commit `c8cd327`), sub-6
  reorgs heal automatically.
- For Option A, the replay must mirror the guest's main loop in
  `program/src/main.rs:223-437` exactly — drift would silently produce
  a state the verifier rejects as not-its-prev. Hard to test without
  parity vectors. Option B avoids this entirely.
