# Private ETH on Ethereum: tacit.wei

A shielded ETH pool that users prove on their own device. Balances are notes of any amount; one transaction can deposit,
pay someone privately with change, withdraw, and pay a relayer. The contracts are immutable: no owner, no pause, no
upgrade. Design and measurements: [`DESIGN-evm-client-pool.md`](../contracts/sp1/confidential/DESIGN-evm-client-pool.md).

The app is **tacit.wei**: one HTML file served from contract code on Ethereum, at `https://tacit.wei.limo/`. This guide
covers what that page does and what an integrator needs to do the same: Ethereum mainnet, ETH (and tokens as ETH),
nothing else. For DeFi (swap, LP, lend, farm), multi-asset notes or the Bitcoin bridge, see
[`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md). The same pool is also deployed on Base, Robinhood Chain and MegaETH,
with token pools beside it on some chains, and other apps use it (anon.wei, tacit.finance/pay/eth, Secret Sats); their
chains, addresses and flows are in [`contracts/deployments/evm-pool.json`](../contracts/deployments/evm-pool.json) and are
not covered here.

## What tacit.wei offers

| Tab | What it does |
|---|---|
| Shield | ETH, or any token swapped to ETH in the same transaction, into your private balance. Optionally split across the fixed Tornado Cash pools (see [Split](#split-fixed-pools-and-tacit)). |
| Send | Pay a `tacit1…` address or a name privately, from the private balance. |
| Withdraw | Any amount to any address, as ETH or as a token. A note in a fixed pool leaves gaslessly. |
| Receive | A standing deposit address anyone can pay, and payment links. |

Everything is proved in the browser, found again from your key (or your 24 words), and needs no account. The page reads
Ethereum from public nodes, or from your own under Endpoints. It also uses the project's relay, forwarders and gateway:
history comes from the relay's index when it answers (the page keeps it only if it builds a tree the pool has held), and
spends go through a relay. Each has a way around it: the chain's logs, and sending from your own wallet. Every outside
service the page uses is named in an onchain registry ([Dependencies](#dependencies-are-registry-driven)).

## Addresses

Ethereum mainnet. CreateX CREATE3, salts locked to deployer `0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`, so no other
sender can deploy at these addresses.

| Contract | Address |
|---|---|
| Pool (`TacitEvmPool`, native ETH) | `0x000000c2A20657CE25f2Ba99737933D031AFBEE9` |
| Router (`TacitEvmPoolRouter`) | `0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5` |
| Groth16 verifier | `0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153` |
| PoseidonT5 | `0x555333f3f677Ca3930Bf7c56ffc75144c51D9767` |
| Zap (`TacitEvmPoolZap`, token to ETH to pool) | `0x0000008EbBF2323f95c4fBc18254f3D65C53998c` |
| zRouter (swap aggregator) / zQuoter | `0x000000000000FB114709235f1ccBFfb925F600e4` / `0x000000bd2DB80567c23E353ca95a251c573cBf9B` |
| Token list (token.list.wei) | `0x0000006013dF75A31678B786061C2B54bf531524` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| RelayRegistry | `0x00000000000299F48Fb844626ab96c6A20059a01` |
| TacitPayRegistry | `0x0000000000029534a955A164223417fc5f4fA405` |
| Catch-up registry (`TacitEvmPoolCheckpoints`) / hub | `0x00000000C3267616ED5E0DAA6F6490D109d6844D` / `0x00000000C824B4F120C03f4Bdd4Bf4656232E835` |
| tacit.wei page (`TacitPay8244`, steward the ops multisig) | `0x000000000009dde9bb333bbad42ad74bbacc2bd6` |

Everything the pool does (shield, send, withdraw, deposit addresses) needs only the pool, router and verifier. The zap,
zRouter and token list are the token flows; the catch-up registry speeds up a new device; the relay and dependency registries
and the page wrapper are tacit.wei's own.
Pool deploy block: 26,069,245; scan events from there. ABIs: [`docs/evm-pool/abi/`](./evm-pool/abi/).
Do not send ETH to the pool or router directly: the pool reverts, and the router hands a stray balance to its next caller.

## Calling the pool

```solidity
function transact(
    uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[11] publicInputs,
    address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1
) external payable;
```

| `extAmount` | Effect |
|---|---|
| `> 0` | Deposit: send exactly `extAmount` wei as `msg.value`. |
| `< 0` | Withdraw `-extAmount` wei to `recipient` (non-zero). |
| `0` | Private transfer inside the pool. |

`fee` goes to `relayer` in the same call (a non-zero fee needs a non-zero relayer). The contract recomputes the asset,
`extDataHash` and `publicAmount`, so recipient, amounts, relayer, fee and memos cannot change after signing. A
withdrawal to a contract first calls it with 100,000 gas; if it does not accept the ETH, the pool delivers it by a forced
transfer that runs no code. `pB` takes snarkjs's `pi_b` with each pair swapped.

**Ordering.** A transaction with an output inserts two leaves at the pool's current size and is proven against the current
root (`oldRoot == root()`, `startIndex == nextIndex()`; `head()` returns both). If another transaction lands first it
reverts with `StaleRoot` or `WrongInsertionIndex`: rebuild the witness against the new leaves and prove again; the
owner's signature does not change. tacit.wei always fills both outputs (an unused one is a zero-value note under a key no
one holds), so a payment without change looks like one with change. Membership may be proven against any root the pool
has held (`everKnownRoot`).

**Indexing.** Rebuild the tree from `Transact` events in `firstIndex` order, appending `(outLeaf0, outLeaf1)`; skip events
where both are zero. Find notes by trial-decrypting memos, and deposit-address notes from the router's `Received`
events. Key notes by `(leaf, index)`: the same leaf can appear twice, and each copy is separately spendable.

### What each action shows

| Action | Public | Hidden |
|---|---|---|
| Shield | The depositing wallet and the amount (for a token: the token and what it spent). | Whose note it creates. |
| Private send | The nullifiers, two new leaves, encrypted memos, and who submitted it (relayer and fee, or your wallet). | Sender, recipient, amount. |
| Withdraw | Recipient, amount, relayer, fee, who submitted it. | Which deposit funds it; the value of any change. |
| Payment to a deposit address | The payer, the amount and the address. | Which wallet owns the address. |
| Sweep of a deposit address | The amount and the box's note key in the call data. | Anything tying that key to your address. |

The table is what the chain shows. The nodes the page reads through also see your IP address beside what it reads:
your deposit addresses when it checks them for payments, and a recipient's name when it looks it up. With your own
node set under Endpoints, those reads go only to it. The reference wallet (`dapp/evm-pool-wallet.js`, used by
tacit.finance/pay/eth) leaves an unused output empty on deposits, merges and withdrawals, so its transactions show how
many outputs they have and whether a withdrawal has change; tacit.wei fills both.

The pool hides which deposit pays a withdrawal and who pays whom. Amounts and addresses at both ends are public: while
the pool is small, a withdrawal of the same amount soon after a deposit is easy to match. Use round amounts, let time
pass, withdraw to a fresh address, and let a relay send it. Spending authority is the Tacit key, not the account that
sends the transaction, so any account can submit your spend.

## Proving on the user's device

One Groth16 circuit, [`transact.circom`](../dapp/circuits/evm-pool/transact.circom): 2 inputs, 2 outputs, 120-bit values,
a depth-32 Poseidon tree, 44,414 constraints. Proofs are 256 bytes and verify in one pairing check. The trusted setup
is closed: 176 contributions, sealed with Bitcoin block 968840 as the beacon.

| Artifact | Size | Where |
|---|---|---|
| `transact.wasm` (witness generator) | ~4.9 MB | `bafybeia7b7euebs6dr7muhhvwf4yh472ftxodikyecxubipam4d7o7sxta`, and tacit.finance/evm-pool/ |
| `transact_final.zkey` (proving key) | ~28.5 MB | `bafybeia6c36bgww2svm6jfg6nl2pk337prc7t6gcfsvhuo5sufqjpi7z4a`, and tacit.finance/evm-pool/ |
| verification key hash | 32 B | `43d11e6e1607e1ea7f3980c9bca91beed95e2e80d173d0873189e99d402e5757`; clients refuse any other key |
| ceremony bundle (transcript, keys, verifier) | | `bafybeia4yvn2zoggvgpjwg5vpwpt6aivjbcm6tgzxoxsukao2nm5yyypfy` |

The page fetches the files from whichever mirror answers, uses them only when their SHA-256 matches the pin, and keeps
them. A laptop proves in 5 to 14 seconds. A signature, not the spending key, authorizes a spend, so a device too slow to
prove can hand the witness to another prover without giving up custody.

The reference client is plain ES modules: [`dapp/evm-pool-zk.js`](../dapp/evm-pool-zk.js) (keys, notes, tree, witness),
[`dapp/evm-pool-zk-prover.js`](../dapp/evm-pool-zk-prover.js) (`makeGroth16System({ vk, wasm, zkey, pinnedVkHash })`),
[`dapp/evm-pool-gateway.js`](../dapp/evm-pool-gateway.js) (deposit addresses, relay intake) and
[`dapp/evm-pool-wallet.js`](../dapp/evm-pool-wallet.js) (the wallet). The same wallet as one import-free module is
`dapp/evm-pool/tacit-evm-pool-wallet.js` (`node build/build-evm-pool-wallet.mjs`, deterministic from the repository).

### Note model

```
npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)            Ak = per-note spend key, NK = nk·Base8 (BabyJubJub)
leaf = Poseidon(asset, v, npk, rho)                v < 2^120
nf   = Poseidon(nk, leaf, index)
asset        = keccak256(abi.encode(chainId, pool, address(0))) mod p     (the pool's ASSET_FIELD())
extDataHash  = keccak256(abi.encode(chainId, pool, recipient, extAmount, relayer, fee,
                                    keccak256(memo0), keccak256(memo1))) mod p
publicAmount = extAmount − fee mod p
Σ inputs + publicAmount = Σ outputs
Public signals: root, oldRoot, newRoot, startIndex, publicAmount, extDataHash, asset, nf[2], outLeaf[2]
```

Keys and stealth derivation are the Bitcoin shielded pool's (`dapp/btc-pool-zk.js`): one wallet seed serves both. A
`tacit1…` address carries the same 97 bytes as its pool lane (see *Tacit address format* in `BUILD-A-TACIT-DAPP.md`).

Each output carries a memo so its recipient can find it. The classical memo is 65 bytes:

```
memo = pk_eph (33) ‖ ct (16) ‖ tag (16)
s    = compress(e·V)  (sender)  =  compress(v·pk_eph)  (recipient)      V = the address's view key
npk, rho = outputKeys(A, N, s)
k    = keccak256("tacit-evm-pool-aead-v1" ‖ s)
ct   = be16(value) ⊕ keccak256(k ‖ 0x0000)[0..16)
tag  = keccak256("tacit-evm-pool-aead-tag-v1" ‖ k ‖ ct)[0..16)
```

A wallet accepts a memo only if `Poseidon(asset, value, npk, rho)` equals the output's leaf.

### Post-quantum memos

A recorder who stores today's chain and later solves secp256k1 could read classical memos. tacit.wei removes that for
its notes with a **post-quantum root**: 32 random bytes shown as a **24-word phrase**, on by default as a sign-in step.
A note's memo, keys, nullifier and owner cannot then be worked out without also breaking ML-KEM-768 or knowing the root.

```
hybrid  1153 B = kem_ct (1088) ‖ pk_eph (33) ‖ ct (16) ‖ tag (16), to an address that names an ML-KEM-768 key
        s = 0x01 ‖ SHA-256("tacit-evm-pool-s-v2" ‖ compress(e·V) ‖ ML-KEM shared secret ‖ kem_ct ‖ pk_eph)
self    65 B, shaped as a classical memo: a note to oneself (deposit, change, merge)
        s = 0x04 ‖ HMAC(self, "tacit-evm-pool-s-self-v1" ‖ pk_eph)
```

A transaction with a hybrid output makes every output hybrid when the sender has a root (its change goes to its own
ML-KEM key), so lengths do not tell the payment from the change. A sender with no root has no ML-KEM key: its change
keeps the 65-byte classical form, so there the lengths do tell them apart. Any transaction with a 1,153-byte memo is a
payment to another address; notes to oneself are 65 bytes. An
address names the ML-KEM key by `SHA-256("tacit-evm-pool-kem-v1" ‖ ek)` in its `0x10` lane; the key travels in the payment
link. Everything derives from the root by HMAC (the ML-KEM pair, the self key, the one-time spend keys, the deposit
addresses, and the seed of whole notes in the Tornado pools), so the 24 words restore a wallet on any device.

What this is and is not: it protects **privacy** against a future adversary. It does not make the proof system
post-quantum: Groth16 over BN254 is pairing-based, and the Tornado Cash pools are not post-quantum either. A forged proof
needs a quantum computer to break the curve; the PQ root keeps recorded history unreadable.

### Payment proofs and payment links

A spend's one-time key is derived from the sender's key (`paymentKey`), so the sender finds its payments again from the key
alone. A payment proof is `(chain, tx, k, e_k)`: anyone holding the recipient's address checks (`verifyPayment`) that
`e_k·G` is the memo's `pk_eph`, that the memo opens under it, and that the note it opens to is the output's leaf. It shows
nothing about any other address. Deposits use a random key and have no such proof.

A payment request link is `#pay=<address>&n=<npk>&ns=<r‖s>&amount=<ETH>&for=<note>`: `n` names the payee's deposit address
and `ns` is the payee's signature over it (`keccak256("tacit-pay-box-v1" ‖ be32(n))`, under the address's view key). The
payer's page pays the deposit address only when the signature checks, so a link whose `n` was swapped cannot redirect a
payment. A payment link that carries money is `https://tacit.finance/pay/eth/#gift=<seed>`: the seed is an identity key
whose pool balance holds the payment, and whoever opens the link withdraws it or sends it into their own balance.

## Deposit addresses (the Receive tab)

`receiveBoxOf(npk, feeBps)` is a standing address tied to one note key of the owner. Anyone pays it ETH, any number of
times, from any wallet or exchange. Anyone then calls `sweepReceive(npk, feeBps, tx)` to move its whole balance into the
pool; the router computes the note itself, so a sweeper can only credit the owner and keeps at most `feeBps` of what it
sweeps. The box's contract exists only inside a sweep, so between sweeps the address has no code and takes a plain
21,000-gas transfer. Only ETH leaves a box; anything else sent there stays.

- The owner can always sweep from any account with no fee. A relay sweeps only when its capped fee (0.25%) covers its gas.
- Payments into one box are public and linked, like any reused address. Give each payer their own box: your key issues
  them and finds them again.
- Never pay a box later in a transaction that swept it: the sweep deletes the account when the transaction ends. A
  contract payout (a Safe, a bridge finalization) should go to a box that has never been paid, or straight into the pool.

**Receive address (canonical, every app shows the same one).**

| | |
|---|---|
| Pool wallet seed | `HMAC-SHA256(key = Tacit identity private key (32 bytes), msg = "tacit-btc-pool-seed-v1")` |
| Wallet keys | `walletKeys(seed, "mainnet")` (`dapp/btc-pool-zk.js`) |
| Box key | `receiveKeys(zk, wallet, 0)`: `ownedKeys(wallet, s)` with `s = 0x00 ‖ keccak256("tacit-evm-pool-receive-key-v1" ‖ be32(n) ‖ be32(i))`, `n` = the wallet's nullifier scalar, `i = 0` |
| Fee cap | `feeBps = 25` |
| Address | `receiveBoxOf(npk, 25)` on the router; offline, `receiveBoxAddress(npk)` |

Vectors (identity key `0x11` × 32):

```
a      = 0x030d4f8c609bcd6f5c961113e9a379b14b5eacfe0cb693e3ee3a21f148144d9e
n      = 0x04b517b015712270664ae5481e694562bb14b28685c492be2436898a8ec97306
npk(0) = 4783613888947850950044057964142544727340891053660060203316524895455918575012
npk(1) = 2799937100355739972349309475928188484188423058204235589221587582372656968697
address (box 0, feeBps 25) = 0x52fc37ee7741468a15CE879320a7a41CEBaeb232
address (box 0, feeBps 0)  = 0x7ABc01dEAC9A65A0d2480a87DB6F22EbC1342639
```

## Tokens

The pool is ETH only; tokens enter and leave as ETH in one transaction, and the token side is public.

- **Shield from a token.** `TacitEvmPoolZap` takes the token from the caller, swaps it through zRouter for exactly the
  deposit's ETH, and deposits it with the caller's own proof. Unspent token and surplus ETH go back to the caller. The zap
  has no owner, holds nothing between transactions, and refuses a plain transfer. The token is pulled by an allowance, an
  EIP-2612 permit, a Permit2 signature, or an approval batched with the zap (EIP-5792), whichever asks least of the user.
- **Withdraw as a token.** `router.withdrawAndCall(tx, intent)` withdraws and runs the calls of a `CallIntent` in the same
  transaction. The withdrawal's recipient is the intent's escrow address, so the proof binds the calls and where their
  outputs go, and a relayer can change neither. tacit.wei's intent is one zRouter call along the route zQuoter finds, paying
  the token straight to the address given; a short fill reverts the withdrawal and nothing is spent. Any failed call
  reverts everything. Whatever remains goes to `refund`. After `deadline` anyone can return the escrow's funds with
  `refundCall`. Calls cannot target the pool, router or escrow.
- Tokens come from the onchain token list (`token.list.wei`).

## Split: fixed pools and Tacit

A fixed Tornado Cash pool holds notes of one size (0.1, 1, 10 or 100 ETH), so a note says nothing about its amount beyond
that size, and the pools are deep. A shield of one whole note or more puts the whole notes into the fixed pools and the
remainder into the Tacit pool, which takes any amount and sends inside itself; below 0.1 ETH everything goes to Tacit. The
page also finds and takes out notes in the newer 0.01, 0.03, 0.3, 3 and 30 ETH pools, but deposits only into the four
deep ones.

Notes come from a seed of the sign-in or of the 24 words (no prompt), or from the wallet's signature, so each is found
again from the key. A fixed note leaves with its gas paid from the note: a paymaster for the pool, through a public
bundler, one ERC-4337 operation from a throwaway account. It can also leave from the wallet. The Tornado Cash side is not
post-quantum, and a Tornado deposit and its withdrawal are linked only as far as the pool's anonymity set allows.

## Relays

A user never needs gas or a funded address: a relay submits the transaction and is paid `fee` out of the user's shielded
funds in the same call. The proof binds `relayer` and `fee`, so a relay cannot redirect funds or raise its fee, and a copy
of the transaction sent by anyone else still pays the relay named in it. Deposits are not relayed: whoever sends a deposit
pays it. Sending from your own wallet is always possible ("send from my wallet instead").

**Choosing a relay.** The RelayRegistry lists relays that hold a bond in TAC (minimum 1,000 TAC, 7-day exit delay). The page
asks them all, takes the quotes that arrive within a four-second window after the first, and draws among those within 25%
of the cheapest, weighted by (lowest fee ÷ fee)². The cheaper relays win more often, and no single relay is required.

**Bounding the fee.** Before signing, the page checks that the quote names this chain and pool and that the fee is at most
0.05 ETH, then shows the cost: what the recipient gets, the relay fee, and what stays in the balance. If the fee later
rises, it says so and asks you to press again at the new fee. A spend that needs notes merged first pays the fee once per
merge. The fee follows gas, so it moves with the network: about 0.0001 ETH at 0.3 gwei and 0.0014 ETH at 2.4 gwei for a send
or withdrawal.

**What a relay sees.** Your IP address, unless it comes through the private route; the transaction it is asked to send (all of
which becomes public); at `/reserve`, the new leaves and the nullifiers being spent; at `/receive`, the chain, note key and
fee cap of each box it is asked to watch. It holds no key that can spend.

**Private route.** Every request to a relay goes as a sealed envelope through a forwarder (see [Private route](#private-route)),
so the relay does not see your IP address and the forwarder does not see the request. A relay listed in the registry is
reached the same way, sealed to its own key. How to run and list a relay: [`RUN-A-PAY-RELAY.md`](./RUN-A-PAY-RELAY.md).

**Many users at once.** The pool inserts only against its current head, so two transactions proven against the same head
cannot both land. A relay keeps a queue: `POST /reserve { outLeaf0, outLeaf1, nfs }` returns a slot (`oldRoot`, `start`,
`pending`) to prove against, and `POST /relay { tx, reservation }` sends the slots in order. A slot not used within 90 s is
cut with the slots behind it. A `409` with `stale: true` means rebuild and prove again; a `400` with `needFee` means gas
moved, so re-quote. `GET /evm-pool/keeper/events?from=<block>` is a history feed; the wallet trusts nothing in it, keeping a
page only if the tree it builds is one the pool has held at that size (`rootSize(root) == size`). Run a relay from
`worker-relay/src/evm-pool-keeper.js`.

## Private route

A relay sees the address each request comes from. The private route takes that away. The page seals every request to the
relay's gateway key and sends it through a forwarder, which hands it to the relay's `POST /sealed`. The relay opens it, runs
it through the handler a direct request reaches, and seals the answer to the request's one-time key.

| | sees |
|---|---|
| the forwarder | the caller's address, when an envelope came and how large it is (4, 8, 16, 32 or 64 KiB), never what is in it |
| the relay | the forwarder's address, and the request |
| whatever hosts the relay | the forwarder's address and a sealed envelope |

It hides a caller from the relay only while the forwarder and the relay are not one party: a forwarder run by the relay's
operator, or one that shares its log with it, hides nothing. In tacit.wei the page's own `rpc` gateway carries only the
bundler call of a gasless note exit; chain reads go from your browser to the page's nodes (or yours, under Endpoints),
which see your IP address. tacit.finance/pay/eth also sends its chain reads through the route while it answers.

- **What it carries:** `info`, `head`, `quote`, `events`, `point`, `totals`, `status/<box>`, `relay`, `receive` and `deposit`;
  anything else is refused. It does not carry `reserve`, so a wallet on the route proves against the queue's tail and sends
  without a slot.
- **The envelope** (`dapp/sealed-request.js`): a one-time secp256k1 key, a shared secret with the gateway key, AES-256-GCM
  for the request and, from a reply nonce, another key for the answer. Only the gateway key opens a request or makes an answer
  that passes its tag, so a forwarder can drop or delay one but cannot read, change or answer it. A request is single use and
  must be within five minutes of the relay's clock.
- **Relays from the registry:** a relay publishes its gateway key, signed by its relayer key, at `/sealed/key`. The page asks a
  forwarder for it (`GET /r/1/<relayer>/key`), checks the signature against the address the registry lists, and posts each
  sealed request to `POST /r/1/<relayer>`. A forwarder that swapped the key could not sign for the relayer, and it calls only
  the `/sealed` routes of a registry entry's public https host.
- **No direct fallback for these.** A request to the page's own relay or to a RelayRegistry relay that no forwarder can carry
  fails; it is never sent direct, which would show your address. A relay in the TacitPayRegistry `keepers` list has no
  gateway key and is reached directly. The ERC-4337 bundler used for a gasless note exit goes through the route to Pimlico or
  Candide. When the route does not carry it, or for any other bundler, the call goes to the bundler directly only after you
  agree (asked once a visit), and the bundler then sees your IP address. The registry's `forwarders` list names the forwarders
  the page uses beside its own.
- **Who sees what is limited to the forwarders you choose.** The forwarders the page ships with are run by the project, so they
  hide you from the relay and its host but not from the people who run them; each independent forwarder added to the registry
  narrows that. Run one with `worker-relay/src/evm-pool-forwarder.js`, and check a setup from outside with
  `node tools/private-route-check.mjs`.

## Dependencies are registry-driven

Nothing the page needs is hard-wired to one host. TacitPayRegistry (`0x0000000000029534a955A164223417fc5f4fA405`; its owner is the ops multisig) holds bytes32
service keys, each a list the page reads and caches for 30 minutes:

| Key | What it lists |
|---|---|
| `rpc`, `logs` | Ethereum nodes and the log source |
| `keepers`, `gateways` | Relay hosts (optionally pinned to a relayer address), and the signed gateway keys for the private route |
| `forwarders` | Sealed-envelope forwarders |
| `bundler`, `paymasters` | ERC-4337 bundlers and the pool paymasters |
| `leaves` | Caches of the Tornado pools' deposit history |
| `mirrors`, `tmirrors` | Mirrors of the Tacit proving files and the Tornado prover (checked against pinned hashes) |
| `wc`, `wcpid` | WalletConnect relay and project id |

The page ships with seeds for each, and uses them if the registry cannot be read. Changing a dependency is a registry write
by the owner; a flag in the registry stops the page from using open-RelayRegistry relays. Redundant copies of the proving
files on other networks are fallbacks and are checked against the same SHA-256.

## Keys and recovery

The Tacit identity key is a hash of an Ethereum wallet's signature over one fixed message (`dapp/identity-message.js`),
the same in every Tacit app, so one wallet opens the same balances anywhere. Sign it only in a Tacit app you trust. A
smart-contract wallet cannot open a key; an account with an EIP-7702 delegation can. Everything else derives from the key: balances, notes and deposit addresses rebuild from the key and the
chain. The browser stores view-level state only (the tree's right edge, the paths of your notes, each note's position,
value and shared secret), sealed under a key from your view key; spending keys are derived when needed and never stored.
On a new device, enter the 24 words, then **Find**, which scans the chain and finds your notes.

### Catch-up points

The pool keeps no leaves, so a new device rebuilds the tree from every `Transact` event since block 26,069,245. A catch-up
point cuts that down: the tree's right edge at a leaf count, with the block at whose end the tree had that count. Anyone who
has read the pool that far posts one to the catch-up registry (`post(size, blockNumber, filled)`); the registry folds the
edge to its root and keeps the post only if `rootSize(root)` on the pool equals `size`, so every point there is one the pool
itself vouches for, whoever posted it. The page takes the newest (`latest()`), checks it the same way, continues the tree from
it and reads the older history behind it in the background; if the events after the point do not begin at its count, it drops
the point and reads from the first block. Older notes are not shown until the background read finishes. Posting costs about
1.7M gas. Relays post one when the pool has grown by 2,000 leaves.

## About the page itself

tacit.wei is generation 1 of its own lineage. `TacitPay8244` is an ERC-8244 contract: `html()` returns the page, which is
stored in 21 chunk contracts of up to 24,575 bytes, and `PAGE_HASH` is the keccak256 of those bytes. A gateway such as
`https://tacit.wei.limo/` (the name `tacit.wei` resolves in WNS to the wrapper) or `https://<wrapper>.w4eth.io/` serves
them; or read it yourself: `cast call 0x000000000009dde9bb333bbad42ad74bbacc2bd6 "html()(string)" --rpc-url <rpc>`.

| | |
|---|---|
| Page | 503,436 B, sha256 `c58a4815f9a328856026eaa6b33c61fba16b220c525c6341dc344458d288057b` |
| Steward | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` (the ops multisig) |
| Record | chunk addresses, transactions and checks in the ERC8244/dapps repository, `tacit-wei/deploy/TACIT-WEI.deployed.md` |

A version never redirects: it serves its own bytes forever, so a reader who audited one stays on it. A later version is a
successor deployed by the steward (`latest()` on any version walks to the newest; the page shows a "newer version" link
only when `tacit.wei` resolves to it); renouncing the steward freezes the lineage. The source is the deployed page: fetch
`html()` to read or adapt it. The page's security policy pins its one script by SHA-256, so any edit needs the pin
replaced.

## Integrator checklist

- Detect the deployment by code at the pool address; pin the verification key hash in `makeGroth16System({ pinnedVkHash })`
  and the proving files by SHA-256.
- Retry stale proofs automatically; send through private order flow.
- Always set a non-zero refund address on an intent, and keep amounts below 2^120.
- Relays: never submit someone else's deposit (`extAmount > 0` pulls `msg.value` from the sender).
- Show the user the fee before signing, and ask again if it moves.
- The chain must support Shanghai (PUSH0) and Cancun (transient storage); size gas from the node.

## Who can change what

The pool, router, verifier, zap and the page's chunks are immutable. What can change is what surrounds them.

| What | Held by | What it can do |
|---|---|---|
| The `tacit.wei` name (WNS) | the ops multisig (`0x006CD14F…49F2`) | point the name at a different page version |
| The page's lineage (`steward()`) | the ops multisig | publish a successor with `deployNext`; every version stays immutable and serves its own bytes |
| TacitPayRegistry (`owner()`) | the ops multisig | change the node, relay, bundler, paymaster, forwarder, gateway and mirror lists the page reads |
| RelayRegistry (`owner()`) | the Z DAO (`0x5E58BA0e06ED0F5558f83bE732a4b899a674053E`) | set the minimum bond, within fixed bounds; relays list themselves by staking |

None of these can move funds, change a proof or redirect a payment: the proof binds the recipient, amount, relay address and
fee, and the proving files are checked against their pinned SHA-256. A hostile list entry would see what a public node, relay
or forwarder sees (above). A hostile page version is the larger risk, which is why you can read, pin or serve a version
yourself (`html()` on the version contract). Check it yourself: `owner()`, `steward()` and WNS `ownerOf` for `tacit.wei`.
