# Run a Pay relay

A Pay relay submits a user's private ETH spend (a send or a withdrawal from the Pay pool) and is paid a fee out of the same spend, so the user needs no gas
and no funded address. Anyone can run one and list it in the relay registry; the Pay page reads the registry and offers a wallet the relays it finds.
(The DeFi pool's settle relay is another service: [RUN-A-RELAY.md](./RUN-A-RELAY.md).)

## The short way: one command, from a laptop or a server

```
git clone https://github.com/src-company/tacit
cd tacit/worker-relay && npm ci
node scripts/pay-relay.mjs --tunnel
```

It needs Node 20 or newer, git, and `cloudflared` for the tunnel (`brew install cloudflared`; the command stops at once, before anything is made, if it is missing).

It makes two keys (files only you can read, in `~/.tacit-relay`): the relay's own, and a fresh address to hold the stake. It prints the relay key's address and waits for 1,000 TAC
and 0.01 ETH to arrive there, starts the relay, opens a public address for it and lists it in the registry. `--tunnel` uses `cloudflared`, so a laptop needs no server and no open
port; with a server that has a name, give `--url https://<the name>` instead. From a checkout of the repository the same command is `node tools/community-runner.mjs relay --tunnel`.

Run it again whenever you like (after a reboot, say). It finds its place in the registry and asks for gas only, never for the stake again, and if the tunnel's name has changed (a tunnel
gets a new one each time it starts) it changes the listed address to match and waits for that to land. `--rpc <your node>` reads and sends through your own Ethereum node instead of the
free public ones.

A new tunnel name is not found in the DNS at once: in testing it took about a minute and a half to answer, and the launcher lists an address only once it answers from your machine. So
after a tunnel drops, the listed address is out of date for that long (wallets pass over a relay that does not answer, and nothing is lost but fees). A relay that is meant to stay up
should have an address that does not change: `--url https://<a name of yours>`, from a server, or from a named tunnel of your own.

Funding, as the command prints it: for the TAC, `tacit.finance/to/<the relay's address>/1001` is a pay link (a payment request, paid in public TAC out of your Tacit account); for the ETH,
sign in on tacit.finance/pay/eth/, open Withdraw and paste the address, which pays a private balance out to it, so nothing links the relay to you.

The stake's owner is public on chain (the registry shows it), so a wallet that is known as yours would tie the relay to you; that is why the owner is a fresh address by default. Its
key is `owner.key` beside the relay's: keep a copy, because it is what takes the stake back (import it into a wallet and connect that wallet on the Pay relays card). To hold the stake
in a wallet of your own instead, add `--owner 0x…`.

A machine that already runs a prover can run a relay beside it. A relay's own proving is small (the deposits it completes, on one thread); a wallet proves its own spend on its own
device, so a relay sells reach, uptime and gas, not proving power.

A new relay needs the pool's history, and free public nodes do not serve history that old, so the launcher reads it from the project's relay through the private route (the relay that
answers sees a forwarder, not your machine). What it reads is checked against the chain's own root, so nothing is taken on trust; `--seed <a relay's url>` reads it from another relay
instead, and a machine that sleeps for hours is read again from the feed when it wakes.

Send the funds from wherever you like: out of a private balance, nothing on chain links the relay to you. A relay earns while it is on
and wallets pass over it while it is off, so a laptop that sleeps loses nothing but the fees. The sections below say what each part does, for running it by hand.

### As a Tor hidden service

```
brew install tor        # or your system's package: tor is the only addition
node scripts/pay-relay.mjs --onion
```

`--onion` takes the place of `--tunnel`. The command starts `tor` with a hidden service pointing at the relay, waits for its name, and lists
`https://<56 characters>.onion/1/evm-pool/keeper` (the registry takes that form as it is). People on Tor Browser then reach the relay without it ever seeing their address, and
nobody learns where your machine is. Unlike a tunnel, the onion name does not change when you restart: it is kept in `~/.tacit-relay/onion`, so the listing stays right.
Keep that folder. The name is the key's, and a copy of the folder on another machine is the same relay address.

A page lists onion relays only when it is on Tor: served from an `.onion` address, or opened once with `?tor=1` on its link (kept in the browser; `?tor=0` turns it off). A page
that is not on Tor never draws one, so an onion relay costs ordinary users nothing. Tor Browser reaches `http://` onion addresses from an `https` page; other browsers block that,
so an onion relay serves people on Tor Browser. For everyone else, run a second relay with `--tunnel` or `--url`. Tor does not hide what is on chain, or which chain nodes a page reads through.

Tor takes a minute or two to publish a new service, and wallets pass over it until then. The relay itself is the same program as before; `--onion` and `--tunnel` can be tried one after the other
on one set of keys.

## What a relay is, and is not

- A spend's proof names the relayer and the fee. The pool pays that address and no one else, so a relay cannot redirect funds or raise its fee after the
  proof is made. A relay that does nothing costs the user a few seconds: the wallet goes on to another.
- You do not see who is asking. A wallet reaches a listed relay only through the private route: it seals each request to your gateway key and a forwarder carries
  it, so the connection you see is the forwarder's, never the person's, and the forwarder cannot read what it carries. You see the spend you are asked to send
  (which is public once it is sent).
- You earn the fee you quote: the gas a spend costs plus the margin you choose.
- The registry takes a stake of TAC to list a relay. It pays nothing and takes nothing: there is no slashing and no registry fee. The stake is yours, held
  for your `owner` address, and comes back when you leave.

## What you need

| | |
| --- | --- |
| A server | any host that runs Docker, with a public name and https. `worker-relay/Dockerfile.evm-pool-keeper` is the image. |
| An Ethereum node | `EVM_POOL_RPC_URL`: your own, or a provider's. A free public node cannot serve the pool's old history: start a new relay from a feed with `EVM_POOL_SEED_FEED_1=<a relay's url>` (the launcher does) |
| A key of its own | a new key, used for nothing else: two services signing from one key race each other for its nonce. It needs ETH for gas. |
| TAC | at least the registry's minimum stake in that key, for the moment you list (1,000 TAC to start; `minStake()` on the registry says what it is now) |
| A second address | the `owner` of the stake: an address of yours that is not the server's key. The owner is public on chain, so a fresh address keeps the relay from being tied to a wallet that is known as yours |

## 1. Run the relay

Run the multi-keeper service (`node src/evm-pool-keepers.js`, in `worker-relay/`), the one that serves the private route: its settings are the keeper's
(the commented `tacit-evm-pool-keeper` block in `worker-relay/render.yaml`, the header of `worker-relay/src/evm-pool-keepers.js`). For Ethereum:

```
EVM_POOL_CHAINS=1
EVM_POOL_CHAIN_ID=1
EVM_POOL_ADDR=0x000000c2A20657CE25f2Ba99737933D031AFBEE9
EVM_POOL_ROUTER_ADDR=0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5
EVM_POOL_START_BLOCK=26069245
EVM_POOL_RPC_URL=<your node>
EVM_POOL_KEEPER_PRIV=<the relay's own key>
EVM_POOL_KEEPER_MIN_FEES=eth:20000000000000
EVM_POOL_KEEPER_GATEWAY_KEY=<the private route key: node src/sealed-keygen.js makes one; keep the secret out of git and logs>
EVM_POOL_WASM, EVM_POOL_WASM_SHA256, EVM_POOL_ZKEY, EVM_POOL_ZKEY_SHA256, EVM_POOL_VK, EVM_POOL_VK_HASH     the finalized ceremony files, by URL and pin
```

The gateway key turns on `POST /sealed` and `GET /sealed/key`: the second shows the key, signed for by your relay key, which is how a wallet that knows only your
address from the registry can be sure the key is yours. `EVM_POOL_KEEPER_FORWARDERS` names the forwarders' addresses, so each may send you what many people
send (the keeper otherwise counts everyone behind a forwarder as one sender): see "Private route" in [EVM-POOL.md](./EVM-POOL.md) for the addresses Tacit's run from.

The registry wants the relay's base URL to end in `/evm-pool/keeper` (for this service, `https://relay.example/1/evm-pool/keeper`), on a public name with https on
the default port. Check the relay before you list it:

```
curl https://relay.example/1/evm-pool/keeper/quote      # must name your key's address as relayer
curl https://relay.example/sealed/key                   # must show a document signed for by that address
```

A relay whose quote names another address is not used, and neither is one that shows no key: wallets reach a relay only through the private route.

## 2. Price it

Your fee is the gas a spend costs at the moment plus your margin, and the wallet asks every relay it knows for a quote on each spend. It takes among the
relays within a quarter of the lowest fee, and a dearer one is drawn less often (its odds fall with the square of its price over the cheapest's), so a
relay priced close to the gas cost is used most. A relay that has not answered a second or so after the first has is left out of that spend.

## 3. List it

```
cd worker-relay && npm ci
RELAY_KEY=0x… node scripts/register-relay.mjs --url https://relay.example/1/evm-pool/keeper --owner 0x<an address of yours>            # every check, nothing sent
RELAY_KEY=0x… node scripts/register-relay.mjs --url https://relay.example/1/evm-pool/keeper --owner 0x<an address of yours> --send     # list the relay
```

It is one transaction: the relay's key permits the registry to take the stake and lists the relay in the same call (`--two-step` approves first and lists after).
It reads the key inside the process (or from `--key-file`), checks that the relay at the URL quotes that key's address and shows a private route key signed for
by it, checks the stake and the gas, and refuses before it sends anything if something is wrong. `--chain` lists a relay for another chain's pool (8453, 4663): the registry keeps a list for each
chain id.

The registry is at `0x00000000000299F48Fb844626ab96c6A20059a01` on Ethereum, verified on Etherscan. `list(chainId, start, max)` shows who is listed.

## 4. Check it

```
node tools/community-runner.mjs relay-check https://relay.example/1/evm-pool/keeper
```

Four checks, the way a wallet reaches the relay: it quotes with an address, it shows a private route key signed for by that address, the registry lists it at this
address, and a sealed quote comes back through Tacit's forwarders. It says which one fails and what to do. It needs no key.

## What the page does with it

The Pay page reads the list for the chain in use (through a node other than the one its wallet uses), keeps the entries a wallet would use (an https URL
ending `/evm-pool/keeper` on a public name, one entry for each relay), draws a few at random next to the relay the page ships with (five relays are asked in
all), and asks each for a quote, through the private route: a forwarder fetches each relay's key document, the wallet checks its signature against the address
the registry lists, and seals the request to that key. A relay is used only if its quote names the address it was listed under and its fee is within what the user was shown.
Nothing else about a relay is trusted, and the page does not rank relays: price does. The page that lives on chain as `anon.wei` does not read the registry.

For a token pool, the page projects a chain's native multi-keeper URL to that pool's ID: `/1/evm-pool/keeper` becomes `/1-tac/evm-pool/keeper`, or `/1-x…/evm-pool/keeper` for a dynamic token pool. The same registry entry and relayer address pin the projected route, so no per-token registry entries are needed. A relay must actually serve and quote that pool; an unsupported route is ignored. Token support is an operator configuration choice, not a registry capability claim.

## Keeping it

The owner address manages the entry from the Pay relays card on the Relay tab of [tacit.finance/prove](https://tacit.finance/prove/#pay-relays): connect the wallet
that owns it and the card shows your relays with the controls below (a top up approves the TAC first, so it is two confirmations; leaving asks twice). The same calls
are on the registry's Etherscan page (Write Contract):

- `topUp(id, amount)` adds stake (anyone may add to an entry)
- `setUrl(id, url)` moves the relay to another host (the owner or the relay's key)
- `startExit(id)` takes the relay off the list at once; `finishExit(id)` pays the stake to the owner once the delay (7 days to start) has passed

The minimum stake and the delay belong to the registry's owner (the Z DAO) to change, inside bounds fixed when it was deployed (250 to 25,000 TAC; 1 to 30
days), and a change takes effect two days after it is queued, so there is always time to see it. An entry whose stake falls under a raised minimum is not
shown until it is topped up. The registry's owner cannot list, remove, move or touch any entry or stake.
