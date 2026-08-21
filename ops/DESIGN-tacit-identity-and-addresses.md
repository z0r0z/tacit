# Tacit Identity — One Key, Four Roles, Four Addresses

The whole key tree in one place: what the single wallet secret is, what derives from it, which
addresses those derivations produce, and which link is deliberately cut.

This is the map. The deep-dives are:

- `DESIGN-eth-wallet-identity.md` — the ETH⇄Tacit derivation in both directions, guards, recovery.
- `DESIGN-confidential-stealth-receive.md` — the one-time-key layer that sits on top of all of this.
- `DESIGN-unified-source-identity.md` (`contracts/sp1/confidential/`) — how the guest reasons about
  note provenance.

Source of record: `dapp/tacit-address.js`, `dapp/prf-wallet.js`, `dapp/evm-account.js`, and the
launch wiring in `launch-v1-mock/app.js`.

---

## The root

One 32-byte secp256k1 scalar, `k`. Nothing else is persisted — every other key is a pure function of
it, so a wallet is recoverable from `k` alone with no server, no registry, and no stored derivation
state.

`k` reaches the wallet by one of three paths, which differ only in where the deterministic bytes come
from:

| path | bytes |
|---|---|
| passkey | WebAuthn PRF output → `prfBytesToScalar` (`dapp/prf-wallet.js`) |
| Ethereum wallet | `personal_sign` (RFC 6979, deterministic) → sha256 → scalar |
| seed | seed → scalar |

`prfBytesToScalar` uses the raw 32 bytes when they land in `[1, n-1]` and otherwise rehashes with a
`tacit-prf-recovery` tag. The rehash branch is unreachable in practice (~2⁻¹²⁸) but the function is
total rather than throwing, because a wallet that cannot be derived is a wallet that cannot be
recovered.

---

## The tree

```
k  (the one root secret)
│
├─ BTC spend key    = k                                          → P = k·G      (33B compressed)
├─ BTC scan key     = tagged_hash("BIP0352/ScanKey", k) mod n    → S = s·G      (33B compressed)
├─ EVM note owner   = P                          ── the SAME point as the spend key
└─ EVM L1 account   = sha256("tacit-evm-account-v1" ‖ network ‖ k) → a DIFFERENT key
```

Three of these are one identity wearing different hats. The fourth is severed on purpose — see
[The deliberate split](#the-deliberate-split).

### BTC spend key — ownership

`k` itself. Signs note spends (BIP-340) and is the pubkey a CXFER transfer is addressed to. `P` is
also what backs the ordinary `bc1q…` funding address.

### BTC scan key — discovery without authority

`s = tagged_hash("BIP0352/ScanKey", k) mod n`, the standard BIP-352 derivation (`_scanPriv`,
`launch-v1-mock/app.js`; `deriveSilentPaymentScanPriv`, `dapp/bitcoin-taproot-wallet.js`).

The split matters: a sender does ECDH against `S` to compute a fresh one-time address for you, and
you scan the chain with `s` to notice it. Holding `s` lets a watch-only device **find** your funds
and never **move** them. Spending still requires `k`.

### EVM note owner — why "one note, two homes" is true

Inside the confidential pool a note's owner is just a pubkey, and it is the same `P`. One identity
owns your notes whether they arrived over Bitcoin or over Ethereum; no bridging step re-keys them.

`launch-v1-mock/app.js` passes `evmOwnerPub: btcSpendPub` explicitly rather than letting the encoder
assume it. The address format keeps the field separate so the two can diverge later without a
version bump.

---

## The addresses

| address | contents |
|---|---|
| `tacit1…` | bech32m of `version ‖ flags ‖ spendPub(33) ‖ scanPub(33) ‖ [ownerPub(33)]` |
| `sp1…` | bech32m of `scanPub ‖ spendPub` under a 5-bit version prefix — plain BIP-352 |
| `bc1q…` | P2WPKH of `hash160(P)` |
| `0x…` | `keccak256(uncompressed pub)[12:]` of the **derived** EVM key |

### The `tacit1` wire format

```
payload = version(1) ‖ flags(1) ‖ btcSpendPub(33) ‖ btcScanPub(33) ‖ [evmOwnerPub(33)]
encoding = bech32m (BIP-350)
```

| field | value |
|---|---|
| version | `0x00` |
| flags | `0x01` Bitcoin lane (mandatory) · `0x02` EVM lane present |
| HRP | `tacit` mainnet · `tactt` signet · `tacrt` regtest |
| length | 68 bytes, or 101 with the EVM lane |

Unlike the silent-payment encoding, the version here is the first **byte of the payload**, not a
separate 5-bit prefix — `_encode` converts the whole byte string at once.

Decoding **is** the resolution — no registry, no lookup, no pool dependency. A sender decodes your one
handle and picks whichever lane they are holding value on. That is the entire content of "pay me
anywhere."

`decodeTacitAddress` rejects an unknown version, an unknown HRP, a payload whose length does not match
its flags exactly, any pubkey that is not a valid curve point, and any address without the Bitcoin
lane. Exact-length rather than minimum-length: two byte-distinct addresses must never decode to the
same recipient.

### Privacy cost, stated plainly

Handing someone your `tacit1` links **your own** two lanes to that person — inherent to a
"pay me anywhere" handle, since both pubkeys are in the string. It does not weaken on-chain
unlinkability for anyone who does not hold the address, and per-lane addresses stay fully supported
for users who want lane isolation.

---

## The deliberate split

The `0x…` account that holds gas and signs transactions is **not** `k`:

```
evmPriv = toValidScalar( sha256("tacit-evm-account-v1" ‖ network ‖ k) )
address = keccak256(uncompressed_pubkey[1:])[12:]
```

Two reasons, both load-bearing:

- **Unlinkability.** Reusing `k` on both chains would let anyone observe that a Bitcoin identity and
  an Ethereum identity are the same person. A privacy product cannot ship that.
- **One-wayness.** A leaked EVM key reveals nothing about `k`. The hash runs one direction only, so
  compromise of the spending-on-Ethereum key does not compromise the wallet.

It is network-bound, so mainnet and signet accounts differ.

### The naming trap

**The "EVM owner pubkey" inside a `tacit1` address is not the `0x…` address.**

| | what it is | derived from |
|---|---|---|
| EVM note owner | who owns notes *inside* the pool | `= P`, the BTC spend pubkey |
| EVM L1 account | an ordinary Ethereum account, for gas | domain-separated hash of `k` |

Same root, different keys, on purpose. Conflating them is the easiest mistake to make when reading
this code, and the two fields sit close together in `myTacitAddress`.

---

## The layer on top

Everything above is the **stable** identity — what you hand out. Actual receives land on one-time
keys so nothing links on-chain:

```
one-time pubkey = x-only(B + s·G)
              s = keccak256("tacit-stealth-ecdh-v1" ‖ compress(e·B)) mod n
              E = e·G          published in the memo
```

The sender picks a random `e` and computes `s` from `e·B`; the recipient recovers the same `s` from
`b·E`. Standard ECDH reached from both sides, so every payment goes to a fresh address that only the
recipient can find and only the recipient can spend.

The guest never sees the ECDH. It verifies a BIP-340 signature under the one-time pubkey and nothing
more, which keeps the consensus surface small — the derivation is dapp-side and can change without a
guest rebuild. Byte layouts live in `dapp/confidential-stealth.js`, mirroring cxfer-core
`stealth_lock_leaf` / `stealth_claim_msg`.

---

## In one paragraph

One secret. The spend key owns, the scan key watches, and the same spend pubkey owns notes on both
chains — so `tacit1` is a single handle that resolves to either lane by decoding it. The Ethereum
account that pays gas is hashed off the root in a way that cannot be walked backward, so the two chain
identities cannot be tied together. Every real payment goes to a fresh one-time key derived by ECDH,
so the stable identity is what you publish, never what appears on-chain.
