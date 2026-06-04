# Ethereum Wallet → Tacit Identity — Derivation, Guards, Recovery

How the dapp deterministically and securely associates an Ethereum EOA with a
tacit bitcoin wallet, and why reconnecting the same ETH account on any device
recovers the full wallet with no seed phrase, no passphrase, and no stored
secret. Documents `ethWallet` in `dapp/tacit.js` (the
`ETHEREUM WALLET DERIVATION` section); verified by
`tests/eth-wallet.test.mjs`.

The same construction (signature → hash → scalar) backs the deterministic
Bitcoin-wallet path (`btcWallet`, directly below `ethWallet` in the source)
and the passkey path (`dapp/prf-wallet.js`, PRF output → scalar). This doc
covers the Ethereum instance; the sibling paths differ only in where the
deterministic bytes come from.

---

## The derivation chain

The association is a pure function from the Ethereum private key to the tacit
wallet — no randomness, no server, no stored secret at any step:

```
ETH key ──personal_sign──▶ 65-byte ECDSA sig ──sha256──▶ toValidScalar ──▶ tacit priv
              (RFC 6979, deterministic)                                       │
                                                               secp256k1 ──▶ tacit pub
                                                                              │
                                                         hash160 + bech32 ──▶ bc1q…/tb1q… P2WPKH address
```

1. **Fixed message.** `_ethDerivationMsg()` returns a constant,
   domain-separated string: it names tacit.finance, pins
   `network: ${NET.name}` and `version: 1`, and states the signature sends no
   transaction and spends no funds. Network binding means signet and mainnet
   derive *different* identities from the same ETH key — intentional
   isolation, matching the per-network wallet model everywhere else in the
   dapp.
2. **Deterministic signature.** The wallet signs the message via
   `personal_sign` (EIP-191). EOA wallets sign with RFC 6979 deterministic
   nonces, so the same key + same message produces the byte-identical 65-byte
   signature on every device, forever. This is the load-bearing property: the
   signature *is* the seed.
3. **Key mapping.** `priv = toValidScalar(sha256(sigBytes))`. `toValidScalar`
   is `prfBytesToScalar` (`dapp/prf-wallet.js`): it maps the 32 hash bytes
   into `[1, N-1]` with a deterministic rehash fallback for the ~2⁻¹²⁸
   out-of-range case, so even the pathological draw derives the same valid
   scalar every time rather than wedging the user.
4. **Address.** `wallet.address()` = `p2wpkhAddress(wallet.pub)` — standard
   hash160 + bech32 under the active network's HRP. Every tacit surface
   (CXFER, etch, AMM, marketplace) keys off this pubkey/address pair.

## Security guards

The derivation alone is deterministic; these checks make it safe to *trust*:

| Guard | Mechanism | What it prevents |
|---|---|---|
| Signer authentication | `recoverEthAddrFromSig(msg, sig)` — full EIP-191 keccak + ecrecover in-page; login hard-fails unless the recovered address equals the connected account | A malicious or buggy provider substituting another account's signature, silently binding the user to a wallet they don't control |
| Contract-wallet rejection | `eth_getCode` checked before signing; non-empty runtime code (Safe / Argent / Ambire, ERC-1271) is refused with an explicit error | Non-deterministic signers: a contract wallet's signature can change across sessions → each login would derive a different, empty wallet |
| EIP-7702 acceptance | The `0xef0100‖impl-address` delegation designator is explicitly *not* treated as contract code (`_ethCodeIsContractWallet`) | False-positive lockout of 7702-delegated EOAs (MetaMask "smart accounts"), whose `personal_sign` is still their own deterministic ECDSA |
| Identity-drift anchor | The derived pubkey is cached (non-secret) under `tacit-eth-wallet-v1`; if a later login re-derives a different key, login throws and locks rather than proceeding | A wallet that changes its signing behavior (or a tampered derivation message) silently dropping the user into a different, empty wallet — assets stay safe on-chain, error is surfaced |
| Account-switch lock | `accountsChanged` handler locks and disconnects the tacit identity the moment the active ETH account differs from the bound one | Operating a tacit wallet derived from account A while the user believes account B is active |
| Secret hygiene | Signature bytes are zeroized immediately after hashing; localStorage holds only `{address, pubkey}`; the tacit privkey lives in page memory for the session and is never persisted | localStorage exfiltration yields nothing secret — there is no encrypted blob because there is no blob |

The trust reduction is exact: whoever can produce that one signature controls
the tacit wallet, and that is precisely the holder of the Ethereum key. The
dapp adds sha256 (preimage-resistant) between signature and scalar, so even a
leaked tacit privkey reveals nothing about the ETH key.

## Cross-device recovery

Because no secret is stored, recovery *is* re-derivation:

1. On a fresh device, choose **Connect an Ethereum wallet** (welcome flow or
   Manage Wallet) → `ethWallet.login()`.
2. The wallet signs the same fixed message → RFC 6979 returns the identical
   signature → identical tacit priv/pub/address.
3. `scanHoldings()` rebuilds the entire portfolio from chain state alone:
   UTXOs at `wallet.address()`, confidential amounts trial-decrypted via ECDH
   keystream derivations against `wallet.priv`, AMM positions recognized from
   `T_LP_ADD` / `T_LP_REMOVE` / `T_SWAP_VAR` envelopes.

No passphrase, no localStorage blob, no export step. The in-source contract
(comment atop `ethWallet`): *"Recovery = reconnect the same ETH wallet on any
device → sign the same message → identical tacit identity → chain scan
restores all holdings."*

The derived key is also **exportable on demand** as a secondary, signer-
independent backup: Wallet → Export key works in eth mode (`btn-export`
handler) — `ensurePrivkey()` re-signs to bring the key into memory if needed,
then the modal shows the raw 64-hex. Nothing is written; the key stays
memory-only. The exported hex restores on any device via the standard
"Import a privkey" path, so even a signer that later drifts (the failure mode
the drift anchor refuses on) costs nothing if an export exists. The relation
is one-way — ETH key → signature → sha256 → tacit key — so an exported (or
leaked) tacit key reveals nothing about the Ethereum key.

## Verification

`tests/eth-wallet.test.mjs` drives the real `ethWallet.login` from
`dapp/tacit.js` (jsdom + `__TACIT_NO_INIT__`) against a mock EIP-1193
provider that performs genuine EIP-191 signing — so `recoverEthAddrFromSig`
agrees without hardcoding the derivation message. Run:

```
node tests/eth-wallet.test.mjs
```

Coverage (10/10 passing as of 2026-06-04):

- derives the tacit key exactly as `toValidScalar(sha256(sig))` and anchors
  the pubkey in state
- **re-unlock reproduces the same identity** — the determinism/recovery
  property
- rejects a smart-contract wallet (non-empty bytecode)
- accepts a 7702-delegated EOA (delegation designator ≠ contract code)
- rejects a signature recovered to a different account than claimed
- refuses identity drift against the enrolled anchor, and the refused login
  leaves the wallet locked

## Properties and limits

- **RFC 6979 dependence.** Determinism is a property of the signer. All major
  EOA wallets (MetaMask, Rabby, Rainbow, Coinbase Wallet) sign
  `personal_sign` deterministically; the contract-wallet gate excludes the
  known non-deterministic class, and the drift anchor catches any signer that
  changes behavior after enrollment on that device.
- **Fresh device has no anchor.** The drift anchor lives in localStorage, so
  a brand-new device can't compare against the enrolled pubkey. A signer that
  drifted would land in an empty wallet there — funds remain on-chain,
  recoverable by whatever produces the original signature.
- **Per-network identity.** The message embeds the network name; the same ETH
  key yields distinct signet and mainnet tacit wallets.
- **Phishing surface is the message itself.** The signature is as powerful as
  the key it derives. The message is fixed, versioned, human-readable, and
  origin-presented by the wallet; any dapp asking for this exact string is
  asking for the user's tacit wallet. (Same trust shape as every
  sign-in-with-Ethereum-derived-key scheme.)
- **Contract wallets route elsewhere.** Safe/Argent users are pointed to the
  passkey path, which has the same no-stored-secret recovery story via
  WebAuthn PRF.
