# What the relays see and keep

A relay here pays gas, and sometimes proving cost, for a transaction a person has already authorised. It holds no funds and cannot redirect a transaction:
the fee and recipient are bound inside the proof. This page says what each relay receives and how long it keeps it.

## The EVM pool relay (the keepers)

- **Transfers and withdrawals are proved in the person's browser.** The relay receives the finished transaction: what the chain will show anyway (recipient,
  amount, fee, nullifiers), and never the note secrets or keys.
- **Deposits go straight from the person's wallet by default**, proved on the device, and the relay is not involved. A person who chooses the optional
  deposit address (a receive box) lets the relay hold the box's receive key so it can sweep what arrives. It keeps that key while it watches the box,
  and drops the box thirty days after the watch lapses. A deposit the relay makes on a person's behalf is held as its note's contents until the deposit ends, and
  the record of it is deleted a week after.
- **Requests go through the private route.** The pay page seals each request to the relay's key and sends it through a forwarder or, if no forwarder
  answers, through public Nostr relays, so the relay sees a forwarder's or a Nostr relay's address and the request, not the sender's address. A request
  that no road can carry fails; it is not sent directly.
- **Forwarders.** A forwarder sees the sender's address and the size and time of each sealed message, not its content, and keeps nothing. The forwarders the
  page names are operated by the project today. Anyone can run one (`tools/community-runner.mjs forward`, docs/COMMUNITY-OPS.md).
- **Rate limits are held in memory** and count requests per address.

## The confidential pool relay (settle)

- **It proves from the person's witness**, so it sees the whole operation while it works, unless the person proves on their own machine and the relay only
  sends. A proof made on the prover network is read by that network.
- **What it keeps:** the witness is deleted when a job settles or its proof is returned; an exit's destination is deleted once the exit has been reported
  done; a job's record is deleted three days after its last change; a client's network is stored only as a keyed hash, used to limit and queue fairly.
- **What it reports:** job status and error text carry no address and no calldata.
- **A page's requests to this relay go through the private route.** A quote, a status, the list of open jobs, a job's submission and its landing are sealed to the API's own
  gateway key and carried by a forwarder, so the API and its host see the forwarder's address, not the sender's. The API counts callers for its rate limits and to share its queue
  fairly between senders; a forwarder gives it a token for each caller, a keyed hash of the caller's network and the UTC day, and the API counts the request under an address made from
  that token. The same network is one sender for a day, nothing in the token is an address, and the next day's does not match. If no forwarder answers, the page sends the request to the
  API directly, so the relay keeps working; the API then sees the sender's address.
- Public reads made when a page loads (statistics, recent activity, the leaderboard) go to the API directly.

## Large pools (Tornado Cash notes)

A deposit of 0.1 ETH or more is split into whole notes for the Tornado Cash ETH pools (0.1, 1, 10 and 100 ETH) and the rest goes into the Tacit pool, in one
transaction. The smallest note is 0.1 ETH, or larger when the network fee for a note would pass 2% of its size; the person can change it. The page offers ETH on
Ethereum only; other chains and tokens open with `?chains=all`.

- **Deposits** are one transaction from the person's own wallet to a depositor contract that has no owner, no setter, no upgrade and holds no balance. No relay is involved.
- **Notes** are derived from the wallet's signatures. Nothing about a note is stored with, or sent to, a service of ours; *Find* recovers them from the wallet.
- **A withdrawal is proved in the browser** and sent as a gas-free ERC-4337 operation: its sender is a throwaway account that never holds anything, and the pool
  pays the recipient and a fee, bound inside the proof, to the wallet keychain's paymaster, which pays the gas. The paymaster and the bundlers (Pimlico's, then
  Candide's) are not ours. The page sends the bundler's calls through the private route to the wallet-read gateway, so the bundler sees the gateway, not the
  person. The gateway sees the operation (the recipient, the fee and the proof, which the chain shows once it is mined) and not the sender's address. If no road is open,
  or a bundler throttles the gateway, the page sends the call to the bundler directly, and the bundler then sees the person's address. The person can instead send the
  withdrawal from their own wallet.
- **A pool's deposit history** is kept by the wallet-read gateway, which reads it from the chain's logs and serves it to the page through the private route in pages of leaves, so no outside host
  sees which pool a person reads or when. When the gateway starts it takes the history from a published cache of the pools' logs (`saga.0000000000.org`, a host none of us runs) once, as a seed, and
  then keeps it current from the chain. The leaves are public chain data, and the page does not trust them: the tree built from them must land on a root the pool knows before anything is proved, and
  a history that does not is read again from the chain alone. If the gateway cannot answer, the page falls back to reading that published cache directly (which then sees the reader's address and which
  pool is read), and then to the pool's logs from the chain, which takes much longer.
- **Ahead of a withdrawal** the page builds the tree of a pool the person holds a note in when they open Withdraw, point at a note's action or look for their notes, from the same history, so the
  withdrawal starts at the proof.
- **Waiting.** The page says how long a note has been in its pool and how many deposits came after it, and says so once when a withdrawal would take a note that went in recently.

## What the private route does not cover

- **Chain reads** of a wallet's own side (its balance, the simulation of a deposit, a transaction's receipt, a name it looks up) go through the route to a wallet-read
  gateway, a service of its own with its own key, so the relay never sees them and the gateway never sees the relay's. The reads of a receive box go to the relay's `/rpc`
  through the route. The public node that answers sees the gateway's or the relay's request, not the wallet's. A read the service does not carry (a method off its
  list, a log range over 5,000 blocks on the relay and 20,000 on the gateway), or any read while no road is open, goes straight to the public node the page names,
  which then sees the reader's address and the addresses it asks about.
- The hosting provider records the network address and path of each request it serves.
- The points lookup sees a connected Ethereum wallet's address.
