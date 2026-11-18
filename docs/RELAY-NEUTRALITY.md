# What the relays see, keep and forget

A relay here is a service that pays gas, and sometimes proving cost, for a transaction a person has already authorised. It does not hold funds and
cannot redirect a transaction: the fee and recipient are bound inside the proof. It applies one rule to everyone: a valid request with a valid fee is
relayed. It keeps no list of addresses to refuse. The only limits are fee floors, daily budgets and rate limits, which apply to every caller alike and
look at neither identity nor purpose.

This page says what each relay does today, including what it cannot hide.

## The EVM pool relay (the keepers)

- **Transfers and withdrawals are proved in the person's browser.** The relay receives the finished transaction. It sees what the chain will show anyway
  (recipient, amount, fee, nullifiers) and never the note secrets or keys.
- **Deposits go straight from the person's wallet by default.** The pay page deposits from the connected wallet, proved on the device, and the relay is
  not involved. A person who chooses the optional deposit address (a receive box) lets the relay hold the box's receive key so it can sweep what arrives; it
  keeps that key for as long as it watches the box, and keeps watching, more slowly, after the watch lapses until the box is dropped to make room. A
  deposit the relay makes on a person's behalf is held as its note's contents until the deposit ends, and the record of it is deleted a week after.
- **Every request goes through the private route.** The pay page seals each request to the relay's key and sends it through a forwarder, or, if no
  forwarder answers, through public Nostr relays. The relay sees a forwarder's or a Nostr relay's address and the request, not the person's address. There
  is no setting to turn this off and no direct fallback: if no road is open, the request fails.
- **The forwarders are run by the project today.** A forwarder sees the sender's address and the size and time of each sealed message, never what is in
  it, and keeps nothing. Because the project runs them, the route hides a person from the relay and its host but not from the project. The Nostr relays
  are independent. Anyone can run a forwarder (`tools/community-runner.mjs forward`, docs/COMMUNITY-OPS.md); each independent one added narrows this.
- **Limits are held in memory.** The relay's rate limits count requests per address in memory and write nothing to disk.

## The confidential pool relay (settle)

- **It proves from the person's witness**, so it sees the whole operation while it works, unless the person proves on their own machine and the relay
  only sends. A proof made on the prover network is read by that network. This relay is not behind the private route: the API's host records the
  network address and path of each request.
- **What it keeps:** the witness is deleted when a job settles or its proof is returned; an exit's destination is deleted once the exit has been
  reported done; a job's record is deleted three days after its last change; a client's network is stored only as a keyed hash, used to limit and queue
  fairly.
- **What it says:** job status and error text carry no address and no calldata.

## What no relay controls

The hosting provider records the network address and path of each request it serves. The private route keeps a person's address from the EVM pool relay
and its host; it does not reach the chain nodes the page reads balances through, or the points lookup, which sees a connected Ethereum wallet's address.

## Anyone can run one

A relay holds no state that cannot be rebuilt, and a person can always send their own transaction, so no relay, the project's included, is a gate.
