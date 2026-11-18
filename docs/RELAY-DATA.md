# What the relays see and keep

A relay here pays gas, and sometimes proving cost, for a transaction a person has already authorised. It holds no funds and cannot redirect a transaction:
the fee and recipient are bound inside the proof. This page says what each relay receives and how long it keeps it.

## The EVM pool relay (the keepers)

- **Transfers and withdrawals are proved in the person's browser.** The relay receives the finished transaction: what the chain will show anyway (recipient,
  amount, fee, nullifiers), and never the note secrets or keys.
- **Deposits go straight from the person's wallet by default**, proved on the device, and the relay is not involved. A person who chooses the optional
  deposit address (a receive box) lets the relay hold the box's receive key so it can sweep what arrives. It keeps that key while it watches the box,
  and keeps watching, more slowly, after the watch lapses until the box is dropped to make room. A deposit the relay makes on a person's behalf is held as its note's contents until the deposit ends, and
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
- This relay is not behind the private route: its host records the network address and path of each request.

## What the private route does not cover

The hosting provider records the network address and path of each request it serves. The route keeps a person's address from the EVM pool relay and its
host; it does not reach the chain nodes the page reads balances through, or the points lookup, which sees a connected Ethereum wallet's address.
