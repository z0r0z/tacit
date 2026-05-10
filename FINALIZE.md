# Finalize the Tacit Mixer Ceremony — Runbook

**Read this entire document before running anything.** This is the one
operation that locks the ceremony. Every step is documented because there
is no second chance without `/reset` (which nukes all contributions).

---

## What this does

Locks the Phase 2 ceremony chain at its current head, applies a
Bitcoin-block-hash beacon, produces the production verifying key, and
unlocks the mixer pool operations (deposit / withdraw / init) for every
dapp tab globally.

---

## ⚠️ Before you start

Do all of these. **Do not skip.**

### 1. Set aside ~15 minutes uninterrupted

Once you start, do not pause between steps. Pausing = orphan
contributions land on the worker but not in the final zkey. Doesn't
break anything cryptographically; just looks sloppy.

### 2. Stop promoting the ceremony URL ~5 minutes before

Lets the contribution rate taper so fewer contributions race the
finalize. Tweet something like *"Closing contributions in 5 minutes —
last call"* and let momentum settle.

### 3. Confirm prerequisites

Run these and confirm the output before continuing:

```bash
# Are you in the repo root?
git rev-parse --show-toplevel
# expected: /path/to/tacit  (NOT something containing 'tmp' or 'wrong')

# Is the local main branch fully synced with origin?
cd "$(git rev-parse --show-toplevel)"
git fetch origin main
git status
# expected: "Your branch is up to date with 'origin/main'."

# Is wrangler authenticated as you?
wrangler whoami
# expected: rosscampbell9@gmail.com

# Is node + npm available?
node --version  # expected: v20+ (anything ≥18 works)
npm --version   # expected: 9+

# Is the worker reachable + the ceremony still live?
curl -s "https://tacit-pin.rosscampbell9.workers.dev/ceremony/1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d/stats" | python3 -m json.tool
# expected: contribution_count > 1100, finalized: false
```

If anything fails: fix it before continuing. Do not proceed if
`finalized: true` already shows — that means someone else (or you in
another shell) already finalized.

### 4. Have your `CEREMONY_INIT_TOKEN` ready

The long random string you set via `wrangler secret put
CEREMONY_INIT_TOKEN` when you initialized the ceremony. Store it
somewhere accessible (password manager). The script will prompt for it
if not in env, or you can export it inline.

### 5. Beacon block selection — handled automatically

If you run the script with no block-height argument (recommended), it
auto-picks `(current tip − 12)` from mempool.space, well past the
6-confirmation reorg-safety threshold. **You don't need to pick
anything yourself.**

If you ever want to override (e.g., to pre-announce a specific block
height publicly before finalize), pass it as the first argument:
`./finalize.sh 847123`. For your scale (1000+ contributors)
pre-announcement is overkill — the coordinator's beacon choice is one
of thousands of independent inputs, not a load-bearing decision.

---

## The actual finalize

### Step 1 — Open a fresh terminal and cd into the script's directory

```bash
cd "$(git rev-parse --show-toplevel)/dapp/circuits"
```

**Don't `export CEREMONY_INIT_TOKEN=...` inline.** That command — including
your token — lands in `~/.zsh_history` / `~/.bash_history` and stays
there until manually wiped. If your laptop is ever compromised the
token is recoverable from that file. The script in step 2 will prompt
you for the token via a silent read (no echo, no history) which is
what you want.

If you absolutely must set it in env first (e.g., scripted automation),
read it from a file or secret manager rather than typing it inline:

```bash
# macOS keychain (token previously stored via `security add-generic-password`):
export CEREMONY_INIT_TOKEN="$(security find-generic-password -s tacit-ceremony-token -w)"

# OR from a file with restricted perms:
export CEREMONY_INIT_TOKEN="$(< ~/.secrets/tacit-token)"
```

Either of those keeps the token out of shell history.

### Step 2 — Run the finalize script

```bash
./finalize.sh
```

**Run with no arguments.** The script will:

- Auto-fetch Bitcoin tip height from mempool.space and pick `(tip − 12)`
  as the beacon block (≥12 confirmations, well past reorg risk).
- Use the canonical ceremony hash baked into the script default.
- Prompt you for `CEREMONY_INIT_TOKEN` via a silent read (no echo, no
  shell history pollution).

**Do not run any other shell commands while it's working.** Don't
switch terminal windows, don't paste anything besides the token when
prompted, don't suspend the script with Ctrl+Z. Let it run to
completion (~2-3 minutes).

### Step 3 — Watch the output

The script will print 8 numbered steps. Expected output:

```
==> [1/8] Fetching ceremony state
    contributions: 1247
    head zkey:     bafybeib...
    finalized:     False

==> [2/8] Downloading head zkey from IPFS
    5510531 bytes

==> [3/8] Fetching Bitcoin block 847123 hash from mempool.space
    block 847123: 00000000000000000001abc...

==> [4/8] Applying beacon (numIterationsExp=10 → 1024 actual iterations)
    wrote build/withdraw_final.zkey (5510531 bytes)

==> [5/8] Pre-flight: verifying beacon-applied zkey vs chain artifacts
    Downloading r1cs (...)…
    Downloading ptau (...)…
    Running snarkjs zkey verify (this can take ~30-60s)…
    ✓ ZKey Ok — beacon-applied zkey verified against chain r1cs+ptau

==> [6/8] POSTing to /finalize
    finalized head_cid: bafybeih...
    state: contributions=1248 finalized=True beacon=00000000000000000…

==> [7/8] Exporting verifying key
    artifacts/verification_key_final.json (nPublic=5)

==> [8/8] Staging ceremony bundle
    ceremony-bundle/ ready (32M)

================================================================
  ✓ Ceremony finalized.
================================================================
```

**The critical line is `✓ ZKey Ok` in step 5.** That's the
local verification of the beacon-applied zkey against the chain's
r1cs + ptau. If this passes, the POST will succeed. If it fails,
the script aborts BEFORE the POST and the ceremony stays open.

---

## What success looks like

After ~2 minutes the script prints `✓ Ceremony finalized.` Now do:

### Step 4 — Verify the worker accepted

```bash
curl -s "https://tacit-pin.rosscampbell9.workers.dev/ceremony/1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d" | python3 -m json.tool
```

Should show `"finalized": true` and `"beacon_block_hash"` matching the
hash printed in step 3.

### Step 5 — Verify the dapp UI updated

Open https://tacit.finance/?ceremony=1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d
in a fresh browser tab.

You should see (within ~30s):
- **🎉 toast** at the top right: *"Ceremony finalized — mixer is now
  live. Beacon ..."*
- **Persistent banner** at top of mixer tab with chain advances + finalize
  time + beacon hash
- **Mixer tab unlocked**: deposit / withdraw / init buttons clickable,
  no `Preview only` lock banners
- **Ceremony state line** shows `✓ FINALIZED (beacon ...)` badge
- **Contribute button disabled** with title "Ceremony finalized; chain
  is locked."

If any of that's missing, hard-refresh the tab once (Cmd+Shift+R).
Edge caches take up to 30s to globally propagate the unlock; the
auto-invalidation we deploy on finalize cuts that mostly to zero, but
some PoPs may lag.

### Step 6 — Pin the ceremony bundle to IPFS

The `ceremony-bundle/` directory has the audit-ready package: r1cs,
ptau, pre-beacon zkey, final zkey, verifying key, attestations dump,
and a README. Pin it as a directory:

**Option A (Pinata web UI — simplest):**
1. https://pinata.cloud → log in
2. Drag the entire `ceremony-bundle/` folder into the upload area
3. Wait for it to pin (~30s for ~32 MB)
4. Copy the directory CID (starts with `bafybei...`)

**Option B (web3.storage CLI):**
```bash
npm install -g @web3-storage/w3cli
w3 login your@email.com  # authenticate once
w3 up ceremony-bundle/   # uploads + returns the directory CID
```

**Option C (local IPFS node):**
```bash
ipfs add -r ceremony-bundle/
# CID is the LAST line of the output
```

Save the directory CID — you'll use it in step 7 as the
`Ceremony CID` when initializing the production pool.

### Step 7 — Initialize the production mixer pool

1. Open https://tacit.finance/ → Mixer tab
2. Scroll to "Initialize a new pool"
3. Fill in:
   - **Asset**: pick from dropdown (the asset you want to mix)
   - **Denomination**: the fixed pool amount in base units
   - **vk JSON**: upload `dapp/circuits/artifacts/verification_key_final.json`
     (the dapp will auto-pin it via the worker and fill the vk CID
     field)
   - **Ceremony CID**: paste the directory CID from step 6
4. Click "Initialize pool & broadcast"
5. Sign the commit + reveal transactions

That's it. The production pool is live.

---

## What could go wrong (and how to recover)

### Pre-flight verify failed in step 5

**Symptom:** Script prints `✗ LOCAL VERIFY FAILED. Beacon-applied zkey
is NOT a valid extension...`

**What this means:** The ceremony is **fine** — nothing was sent to the
worker. The beacon-application step locally produced a malformed zkey.

**Recovery:**
1. Check `build/verify.log` for the snarkjs error
2. Most likely cause: a partial download or stale local artifact —
   delete `build/` and re-run the script
   ```bash
   rm -rf build/
   ./finalize.sh 847123
   ```
3. If verify still fails after a clean rerun, paste `build/verify.log`
   to me before doing anything else.

### Worker rejects the POST in step 6

**Symptom:** Script exits with `curl: (22) The requested URL returned
error: ...`. The chain stays open (not finalized).

**Common causes + recovery:**

| Worker response | Cause | Fix |
|---|---|---|
| `401 unauthorized` | Wrong/missing `CEREMONY_INIT_TOKEN` | Re-export the correct token, re-run |
| `404 ceremony not found` | Wrong circuit hash | Verify `TACIT_DEFAULT_CEREMONY_HASH` in dapp matches the worker's KV |
| `409 ceremony already finalized` | Already finalized (somehow) | Verify with curl in step 4; if truly already finalized, you're done |
| `400 beacon_block_hash must be exactly 64 hex chars` | mempool.space returned something weird | Re-pick block, try again |
| `502 pin failed` | Pinata is having an outage | Wait a few minutes, re-run |

### Network error mid-POST

**Symptom:** Script hangs or curl times out mid-step-6.

**What this means:** Ambiguous — the worker may or may not have accepted
the upload before your connection dropped.

**Recovery:**
1. **Don't immediately retry.** Wait 30 seconds for the worker to settle.
2. Check state with the curl from step 4:
   ```bash
   curl -s "https://tacit-pin.rosscampbell9.workers.dev/ceremony/1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d" | python3 -m json.tool
   ```
3. If `finalized: true` → you succeeded, just continue to step 4 of the
   runbook (verify dapp UI updated)
4. If `finalized: false` → you didn't succeed; safely re-run the script

### Browser tab still shows locked mixer 5+ minutes after finalize

**Symptom:** Banner doesn't appear, lock-banners don't go away, despite
worker showing `finalized: true`.

**Recovery:**
1. Hard-refresh the tab (Cmd+Shift+R / Ctrl+Shift+R)
2. If still locked, open DevTools → Application → Local Storage →
   delete `tacit:ceremony:...:celebrated` and `:banner-dismissed` keys
3. Hard-refresh again

This is a client-side cache issue, never a chain issue. The chain is
final once the worker writes `finalized: true`; the dapp will catch up.

### **DON'T** run `/reset` to recover from anything

`/reset` wipes ALL contributions. The only legitimate use is "the
Phase 1 ptau was discovered to be backdoored" — not "I made a typo
in the beacon block hash". Every error path above is recoverable
without `/reset`. **If something feels wrong, ask before resetting.**

---

## Confirmation that you finalized correctly

After step 7 (pool init), do this end-to-end smoke test in any browser:

1. Make a small deposit to the new pool
2. Wait for confirmation depth ≥3 blocks
3. Withdraw to a fresh address
4. Verify the recipient sees the withdrawn UTXO

If all four pass, the ceremony was correct.

---

## Quick reference (for after-the-fact)

| Item | Where |
|---|---|
| Final zkey | `dapp/circuits/build/withdraw_final.zkey` |
| Verifying key (production) | `dapp/circuits/artifacts/verification_key_final.json` |
| Audit bundle | `dapp/circuits/ceremony-bundle/` |
| Pre-beacon head zkey (the one your contributors built) | `dapp/circuits/build/withdraw_pre_beacon.zkey` |
| Snarkjs verify-from-r1cs trail | `dapp/circuits/build/verify.log` |
| Worker state endpoint | `https://tacit-pin.rosscampbell9.workers.dev/ceremony/<hash>` |
| Contribution attestations | `https://tacit-pin.rosscampbell9.workers.dev/ceremony/<hash>/attestations?cursor=...` |

---

## When you're done

Tweet something like:

> Tacit ceremony finalized. Final chain depth: <N> contributions across
> <M>+ distinct contributors. Beacon: Bitcoin block <height>
> (<short hash>...). Mixer is now live. Audit bundle: <ipfs CID>.

Then you can sleep.
