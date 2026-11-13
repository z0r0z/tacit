# Through a pool: a private source for a deposit

The Deposit tab on [tacit.finance/pay/eth](https://tacit.finance/pay/eth/) has a third mode, **Through a pool**: deposit ETH into the first
generation of [Privacy Pools](https://v1.privacypools.com/) (the ETH pool, about 710 ETH from 6,500 deposits at last read), watch its review, and
take it into a fresh Tacit receive address through a relayer. All of it happens on the page. The account is the pool app's own kind, so the same
deposits show in the pool's own app under the recovery phrase the panel shows, and the whole account comes back from the Tacit key alone.

The mode is off by default. Open the page once with `?pool=1` to turn it on in that browser (`?pool=0` turns it off).

## What it is for

A withdrawal from the pool is an ordinary payment to an address, so the address that took it in has no on-chain link to the address that
deposited. The set a Tacit user hides in on the way in is the pool's, which is far larger than any one of Tacit's pools holds. It is the
**source** that is private. Tacit exits stay public (recipient and amount), and two sets never add up: the best case is the larger of the two.

The pool adds a rule of its own, the association set. Its approval service reviews each deposit and publishes the labels it approves; a
withdrawal proves the deposit is among them. A deposit that is not approved cannot be taken in, and its way out is the public exit back to the
depositing address.

## The account

Everything an account needs comes from the Tacit key.

| Step | What |
|---|---|
| Pool key | `sha256("tacit-assoc-pool-key-v1" ‖ tacit key)`, a plain secp256k1 key. It makes the deposits and signs the public exit. Any wallet that imports it reaches the same account. |
| Seed | The pool app's wallet-based key generation, run with the pool key: it signs the EIP-712 `DeriveSeed` message, HKDF-SHA256 over `r` (salt: the address) gives 32 bytes, shown as a 24-word phrase. |
| Master keys | BIP-39 → BIP-32 `m/44'/60'/{0,1}'/0/0` → two scalars → Poseidon → the master nullifier and secret. |
| Deposit `i` | nullifier and secret = `Poseidon(master, scope, i)`; child `j` of a deposit (change) = `Poseidon(master, label, j)`. |
| Discovery | Index 0, 1, … are hashed into precommitments and matched against the pool's `Deposited` events, stopping after 10 misses in a row. Each deposit's withdrawals follow its nullifiers. Where two deposits share a precommitment, the earlier is kept. |

**Recovery.** A new device with the same Tacit key finds every deposit, its review status and any change. To see them in the pool's own app,
show the recovery phrase in the panel and restore it there. A deposit made from another wallet with that phrase turns up under **Search every
deposit**. The exit of a deposit needs the address that made it: the pool key, or the wallet that was connected for it.

## The flow

1. **Deposit.** From the pool key (the panel shows its address to fund) or the connected wallet. The minimum and the pool's cut are read from the
   entrypoint (0.01 ETH and 0.5% at last read).
2. **Reviewing, then Approved or Not approved.** The panel polls the approval service. A take-in proves membership in the list the service
   publishes, and the entrypoint accepts only the root it posted last, so a deposit approved a moment ago can wait a few minutes for the post. The
   page says so, and the deposit stays in the account.
3. **Take in.** Choose an approved deposit and an amount (any part; the change stays in the account). The page picks the next unused receive
   address that it already watches, asks the relayer for a quote, proves the withdrawal in a worker, and sends it to the relayer. The relayer's
   fee is 10 bps plus 650,000 gas at the current price, as a share of the amount; the page asks for the quote plus a fifth, within the entrypoint's
   maximum (10% at last read), and shows the amount that arrives. A very small amount is marked too small to relay at the current gas price.
4. **Exit.** A deposit that is not approved goes back to its depositing address with a proof from the small commitment circuit. This is public.

The proofs are made on the device, in a worker, with the pool's own circuits: the withdrawal circuit (about 20 MB) on the first take-in and the
commitment circuit (about 3 MB) on the first exit. The files are fetched from the pool's host, checked against the sha256 hashes in
[`dapp/assoc-pool.js`](../dapp/assoc-pool.js) (`CIRCUITS`, the hashes its own SDK pins), and kept in Cache Storage. A file with another hash is
refused.

## What other parties see

| Party | Sees |
|---|---|
| The approval service | The page's IP and the labels it asks about. |
| The explorer API | The page's IP and queries by the pool key's address, which has no link to any Tacit address. |
| The relayer | The page's IP, the amount and the receive address it pays. |
| The chain | A deposit from the pool key or the wallet; later a relayed withdrawal to the receive address. |

As with any private payment, wait between the deposit and the take-in, take in a round amount, and use a receive address once. No server of
Tacit's is involved; the browser keeps the last few take-ins (amount and receive address) to avoid reusing an address.

A take-in earns no points: points follow public addresses, and a private source cannot earn them without being linked.

## Code and hosts

The modules are [`dapp/assoc-pool.js`](../dapp/assoc-pool.js) (pure: keys, trees, proofs' inputs, calldata, discovery),
[`assoc-pool-net.js`](../dapp/assoc-pool-net.js) (lists, events, terms, the relayer), [`assoc-pool-session.js`](../dapp/assoc-pool-session.js)
(the workflow), [`assoc-pool-prove-worker.js`](../dapp/assoc-pool-prove-worker.js) (proving) and [`assoc-pool-ui.js`](../dapp/assoc-pool-ui.js)
(the panel); [`bip39-english.js`](../dapp/bip39-english.js) is the word list, checked against its published hash. The page's content security
policy allows four hosts for it: the approval service (`api.0xbow.io`), the explorer API (`api.routescan.io`), the relayer (`fastrelay.xyz`) and
the pool's circuit files (`v1.privacypools.com`). No server of Tacit's is involved.

## Tests

| Test | What it covers | Needs |
|---|---|---|
| `tests/assoc-pool.test.mjs` | The published BIP-32, BIP-39, EIP-712, RFC 5869 and circomlib vectors, the derivation, trees, context and calldata, discovery, withdrawal planning. | Nothing. |
| `tests/assoc-pool-net.test.mjs` | The service layer against stand-ins: lists, review status, log pages and a broken log, the entrypoint's terms, the relayer's fee and its refusals, completeness against the pool's counters. | Nothing. |
| `tests/assoc-pool-fork.mjs` | The live contracts and the pinned circuits on an anvil fork of mainnet: deposit, approval, a withdrawal to a Tacit receive box, rediscovery from the key, the change spent, the public exit, and the session workflow. | `anvil`, network, `ASSOC_ARTIFACTS=<dir with the six circuit files>`. |
| `tests/assoc-pool-page.mjs` | The page itself in Chromium on the same fork, with its content security policy on: the pool key, a deposit signed in the page, the withdrawal proved in the worker and relayed to the page's receive address, the account found again after a reload, the public exit, the recovery phrase. | The same, plus `PLAYWRIGHT=<path to playwright-core>`. |

The account was also read by the pool's own SDK: its `AccountService`, run on events made by this code, finds the same deposits, indices,
chains of change and exits, and the same next deposit index (463 primitive checks and 236 account checks). The one difference is a deposit's
change made with other keys: the SDK records an unspendable migration child, and this code stops at the note it still holds.

## Trying it with a small amount

1. Sign in on [pay/eth](https://tacit.finance/pay/eth/?pool=1), Deposit → Through a pool, and send 0.01 to 0.02 ETH to the pool key's address
   (or connect a wallet and deposit from it).
2. Wait for **Approved** (from minutes to a day or more).
3. Show the recovery phrase and restore it in the pool's own app: the deposit and its status are there.
4. Take part of it in. The page shows the transaction, and the receive address sees the ETH.
5. Open the page on a clean browser profile with the same key: the deposit, the change and the take-in are found again.
6. A deposit that is not approved, or an approved one the owner wants back, is exited to the address that made it.

## Scope

The panel reads the first generation's ETH pool. The second generation has its own contracts and set. Token pools use another asset address and
the same circuits, so the account, the discovery and the calls carry over, but the panel does not offer them.
