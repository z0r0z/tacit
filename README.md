<p align="center">
  <img src="./tacit.svg" alt="tacit" width="120">
</p>

# tacit

Confidential token meta-protocol on Bitcoin. Amounts hidden, supply enforced from chain data, indexer-validated in the browser.

> **Status:** signet demo. Single-file dApp + one
> stateless Worker for image upload / faucet / asset registry.
>
> **Live demo:** [tacit.wei.is](https://tacit.wei.is)

---

## What it is

Like Runes or BRC-20, tacit is a token meta-protocol on Bitcoin: token rules
aren't enforced by Bitcoin nodes, they're enforced by an indexer that anyone
can run and reach the same verdict. Unlike Runes/BRC-20, tacit hides the
**amounts**: each on-chain commitment is a Pedersen point, accompanied by a
rangeproof and (for transfers) a Mimblewimble-style kernel signature that
together prove conservation of supply without revealing individual balances.

The indexer in this repo runs **inside the dApp**, in your browser, against
chain data fetched from `mempool.space`. There's no server-side authority,
no federation, no off-band proof exchange. Two browsers running the same
file against the same chain reach the same verdict.

What that buys you, concretely:

- A user can **etch** a confidential asset with a hidden initial supply.
- They can **transfer** privately — observers see commitments + rangeproofs
  in the witness, never amounts.
- A recipient with only their privkey can **recover their balance from chain
  alone** — no share-link required (each commitment carries an ECDH-encrypted
  amount field that only the recipient and sender can decrypt).
- Anyone can **validate** every UTXO's ancestry independently.

What it doesn't do:

- Hide the address graph (sender/recipient bitcoin addresses are visible).
- Hide the asset ID (which token is being moved is public).
- Magically scale — each transfer carries ~10 KB of bit-decomposition
  rangeproofs. Bulletproofs would shrink this 7×; that's the next major
  protocol revision.
- Protect issuer-claimed initial supply (the supply commitment is hidden, so
  there's no way for a third party to verify the etcher's announced number;
  same trust model as any centralized stablecoin).

---

## User stories

**Alice mints a token.** Alice opens `tacit.html`, gets a fresh wallet (one
privkey, browser-only). She clicks the faucet for some signet sats, fills in
ticker = `ALICE`, supply = 1000, decimals = 2, optionally uploads an image.
She hits Etch. Two transactions go on chain (commit + reveal). On chain,
anyone can see a new ALICE token exists and that its supply is some integer
in `[0, 2³²)` — but only Alice knows the supply is 1000.

**Alice sends 50 ALICE to Bob.** Alice pastes Bob's pubkey (Bob copied it
from his Wallet tab). The dApp builds a CXFER tx: input = Alice's supply
UTXO (commits to 1000), outputs = recipient (commits to 50, blinded with an
ECDH key only Alice and Bob can derive) + change (commits to 950, blinded
with Alice's own key). A kernel signature proves inputs − outputs balance
to zero. On chain: ALICE moved, neither amount visible.

**Bob recovers on a fresh device.** Bob enters his privkey on a clean
install. The dApp scans signet for outputs paying his pubkey, walks each one
back through CXFER history to its CETCH ancestor, verifies every rangeproof
and kernel sig locally (no trust in any server), derives the ECDH key with
the sender, and decrypts the amount. **No share-link or sync server
required.** Privkey alone reconstructs the wallet.

**Carol browses what tokens exist.** Carol clicks Discover. The dApp hits
the Worker's `/assets` endpoint, which has been chain-scanning signet every
5 minutes for CETCH envelopes. She sees the gallery (ticker, image, etch tx)
and "scanned through block X · N blocks behind tip" so she knows how fresh
the data is. She can't see anyone's balances or supplies — only that the
token exists.

**Alice optionally pings Bob with a share-link.** After broadcasting, the
dApp emits a URL ending in `#recv=…` containing the opening (amount +
blinding). Alice DMs it to Bob; clicking it imports the opening directly,
skipping a chain scan. **This is purely UX — Bob's recovery story above
works regardless.** Share-links notify, they don't authorize.

---

## Repository layout

```
tacit/
├── tacit.html          # the dApp — single file, ~3000 lines, no build step
├── tacit.svg           # logo
├── worker/             # Cloudflare Worker: /pin /pin-json /drip /balance /assets
│   ├── src/index.js
│   ├── wrangler.toml
│   ├── package.json
│   └── README.md       # Worker-specific deployment notes
├── README.md           # you are here
└── LICENSE
```

`tacit.html` is the entire client. It pulls `@noble/secp256k1`, `@noble/hashes`,
and `@scure/base` from `esm.sh` at runtime; everything else (Pedersen
commitments, bit-decomposition rangeproof, BIP-340 Schnorr, BIP-341 Taproot,
envelope encode/decode, Mimblewimble kernel sig, ECDH-derived blindings,
encrypted-amount keystreams, recursive validator, P2WPKH wallet) is inline.

The `worker/` directory holds an optional Cloudflare Worker that provides
demo conveniences (image pinning to IPFS, signet faucet drip, asset
directory). **The Worker holds no trust-bearing logic.** Setting
`WORKER_BASE = ''` at the top of `tacit.html` disables it entirely; the
protocol still works.

---

## How the protocol works (one screen)

```
ETCH (one-time, mints a new asset)
─────────────────────────────────
 commit-tx → P2TR output committed to envelope
 reveal-tx → spends P2TR via script-path, exposes envelope in witness:

     CETCH || ticker || decimals || C(33B) || rangeproof(5152B)
            || amount_ct(8B) || image_uri(≤256B)

   C = supply·H + r·G        (Pedersen commitment to supply)
   amount_ct = supply ⊕ HMAC(etcher_priv, "tacit-etch-amount-v1" ‖ anchor)
   r          = HMAC(etcher_priv, "tacit-etch-v1" ‖ anchor)

   anchor = first input outpoint of commit-tx (so the etcher can recover
            the supply opening from chain + privkey alone)

   asset_id = sha256(reveal_txid ‖ vout=0)


TRANSFER
────────
 commit-tx → P2TR output committed to envelope
 reveal-tx → spends commit-tx + asset UTXO(s); envelope:

     CXFER || asset_id || kernel_sig(64B) || N || (C_i, rangeproof_i, amount_ct_i)*N

   r_recipient = HMAC(ECDH(sender_priv, recipient_pub), "tacit-blind-v1" ‖ anchor ‖ vout)
   r_change    = HMAC(sender_priv,                       "tacit-change-v1" ‖ anchor ‖ vout)
   amount_ct   = amount ⊕ keystream  (ECDH-derived for recipient, self-derived for change)

   excess = (Σr_out − Σr_in) mod N
   E'     = ΣC_out − ΣC_in
   kernel_sig verifies under E'.xonly() — proves Σa_out = Σa_in without revealing amounts


VALIDATION (recursive, browser-side)
────────────────────────────────────
 For each wallet UTXO:
   1. Decode envelope at parent_tx.vin[0].witness[1]
   2. If CXFER, recursively validate every input outpoint
   3. Verify all rangeproofs (~350ms each)
   4. Verify asset_id consistency across inputs
   5. Verify kernel_sig under (ΣC_out − ΣC_in).xonly()
   6. Resolve own (amount, blinding) via local cache OR trial-decrypt amount_ct

 Memoized; O(N) over chain depth N.


RECOVERY
────────
 Privkey + chain → full wallet state. No share-link required, no localStorage
 backup required. The wallet trial-decrypts every commitment it owns:
   - As recipient (ECDH against sender pubkey at vin[1].witness[1])
   - As own change      (self-derived keystream)
   - As own etched supply (self-derived from commit input outpoint anchor)
```

For more detail, open the dApp and read the **Protocol** tab — the
on-page docs spell out the wire format, attack vectors, blinding
delivery, and trust model.

---

## Running the dApp

The dApp is a single HTML file. There's no build step.

### Locally (fastest path)

```sh
# any static file server works
cd tacit/
python3 -m http.server 8000
# open http://localhost:8000/tacit.html
```

CORS is allowlisted for `http://localhost:8000`, `:3000`, `:127.0.0.1:8000`,
and `null` (`file://`) in the deployed Worker, so local dev hits the live
endpoints out of the box.

### Hosted

Drop `tacit.html` on Cloudflare Pages, GitHub Pages, Vercel, or any
static host. There are no env vars or build flags — the Worker URL and
IPFS gateway are set at the top of the script:

```js
const WORKER_BASE  = 'https://tacit-pin.rosscampbell9.workers.dev';
const IPFS_GATEWAY = 'https://content.wrappr.wtf/ipfs/';
```

Once you know your hosted origin, narrow `ALLOWED_ORIGINS` in
`worker/wrangler.toml` to it, then `wrangler deploy`.

---

## Using the dApp

1. **Wallet.** A signet privkey is auto-generated on first load and stored
   in `localStorage`. Export/import via the buttons; new wallet wipes and
   regenerates.
2. **Get sats.** Click ⚡ Demo drip — single round trip, no captcha. (If the
   faucet is empty, the Manual faucet button opens public signet faucets as
   a fallback.)
3. **Etch.** Pick a ticker, supply, decimals (0–8). Optionally upload an
   image and add description / external URL — the dApp pins a JSON metadata
   blob to IPFS and stores its CID in the envelope. Click Preview, then
   Etch & broadcast. Two transactions go out (commit + reveal); the second
   confirms in ~10 minutes on signet.
4. **Transfer.** Pick an asset, paste recipient's pubkey (they read it off
   their own Wallet tab), enter an amount. Click Preview, then Transfer &
   broadcast. The recipient auto-discovers the balance on next scan via
   the on-chain encrypted-amount field.
5. **Holdings.** Lists your assets with images, descriptions, balances.
   ↻ Rescan UTXOs forces re-validation. ⌕ Discover lists every asset
   etched on signet (cached by the Worker's cron).

### Recovery sanity check

Open the dApp in a fresh incognito window. Import your privkey via the
Import key button. ↻ Rescan UTXOs. Your full balance — across received
transfers, your own etches, and your change — should reappear from chain
data alone.

---

## Trust model

| What you trust                    | For what                                             | Mitigation if compromised                                          |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| Bitcoin (signet)                  | Tx ordering, no double-spends, witness data integrity | None — it's the bottom layer                                       |
| `mempool.space` API               | Returning real chain data                             | Swap for any other Bitcoin node API                                |
| The `tacit.html` file you loaded  | Implementing the validation rules correctly          | Re-host, audit; pin by content hash                                |
| The asset's etcher                | The supply they announced                             | Out of scope — same as any centralized stablecoin issuer            |
| `@noble/secp256k1` from `esm.sh`  | Crypto code matching what was published              | Vendor it (replace `https://esm.sh/...` with a local copy)          |

The Worker is a **convenience cache**, not a trust target. Setting
`WORKER_BASE = ''` disables it; the protocol still works (no auto-faucet,
no image upload, no asset directory, but every existing token still
validates and transfers correctly).

---

## Privacy scope

Tacit hides **amounts**. It does not hide:

- Address graph (sender/recipient bitcoin addresses are visible).
- Asset ID (the 32-byte asset_id is in every CXFER envelope).
- Sender pubkey (visible at `tx.vin[1].witness[1]` — the recipient needs it
  for ECDH blinding recovery).
- Tx graph (inputs and outputs are linkable like any UTXO chain).

This is strictly weaker than Mimblewimble (which hides the tx graph via
cut-through) and weaker than Liquid CT with surjection proofs (which hides
asset_id). It's the same scope as Liquid CT without surjection proofs.

---

## Known limitations / roadmap

- **Range is 32-bit.** Supply per asset_id is capped at 4.29 × 10⁹ base
  units. With 6 decimals (USDC-style) that's ~$4,294 max issuance. This is
  a per-asset cap, not a per-UTXO cap — wallets split balances across UTXOs
  the same way Bitcoin already does. The fix is bulletproofs at 64-bit
  range, which is also a 7× witness compression.
- **Bit-decomposition rangeproofs are 5,152 bytes per output.** A 2-output
  CXFER witness is ~10 KB. At signet rates this is invisible; at mainnet
  rates (≥10 sat/vB) this would be $5–25 per transfer until bulletproofs.
- **Recursive validation is O(chain depth) on cold cache.** Memoized within
  a session; mobile users on deep chains will struggle. A persistent
  validator cache would be a real production add — currently out of scope.
- **localStorage is the wallet.** Demo-grade. Use a fresh signet key, never
  reuse with mainnet funds.
- **Issuer trusts.** The CETCH supply commitment is hidden, so there's no
  cryptographic check on the etcher's announced supply. Downstream of etch,
  no one can inflate, but the etcher could lie about how much they minted.
- **Single-asset CXFER only.** No multi-asset transfers, no swaps in one
  envelope.

---

## Cloudflare Worker (optional but recommended for demos)

The Worker holds three secrets — `PINATA_JWT`, `FAUCET_PRIV` (signet only),
and the configured CORS allowlist. It exposes:

| Endpoint        | Method | Purpose                                                           |
| --------------- | ------ | ----------------------------------------------------------------- |
| `/pin`          | POST   | Image upload to IPFS via Pinata                                    |
| `/pin-json`     | POST   | Metadata-blob pin (used when etching with description / URL)        |
| `/drip`         | POST   | Send 20K signet sats to `{address}` — 1/IP/day, 1/addr/day         |
| `/balance`      | GET    | Faucet wallet's signet balance + funding address                  |
| `/assets`       | GET    | List of all known etched assets (cron-populated)                   |
| `/assets/:id`   | GET    | Single asset metadata                                              |
| `/scan`         | POST   | Manual scan trigger (debug)                                        |
| `/rescan`       | POST   | Rewind `meta:last_scanned` to a given height (debug, `?from=<h>`)   |
| _scheduled_     |        | `*/5 * * * *` — scan recent signet blocks for new CETCH envelopes  |

Setup steps live in `worker/README.md`. Deploy your own (and update
`WORKER_BASE` in `tacit.html`) if you want isolated keys / quota.

---

## Cryptography credits

- Pedersen commitments + Mimblewimble kernel sigs — Maxwell, Poelstra,
  Jedusor.
- Bit-decomposition rangeproof with Borromean ring sig — Maxwell &
  Poelstra, "Confidential Transactions" (2015).
- BIP-340 Schnorr / BIP-341 Taproot — Wuille, Nick, Towns.
- The "indexer-validated meta-protocol" framing comes from Runes / Ordinals;
  tacit is a CT-flavored cousin in the same family.
- All primitives come from [`@noble/secp256k1`](https://github.com/paulmillr/noble-secp256k1)
  and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes).

---

## License

See `LICENSE`.
