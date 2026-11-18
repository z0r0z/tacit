# Run a Pay relay

A Pay relay submits a user's private ETH spend (a send or a withdrawal from the Pay pool) and is paid a fee out of the same spend, so the user needs no gas
and no funded address. Anyone can run one and list it in the relay registry; the Pay page reads the registry and offers a wallet the relays it finds.
(The DeFi pool's settle relay is another service: [RUN-A-RELAY.md](./RUN-A-RELAY.md).)

## What a relay is, and is not

- A spend's proof names the relayer and the fee. The pool pays that address and no one else, so a relay cannot redirect funds or raise its fee after the
  proof is made. A relay that does nothing costs the user a few seconds: the wallet goes on to another.
- You see what any relay sees: the connection's IP address and the spend it is asked to send (which is public once it is sent).
- You earn the fee you quote: the gas a spend costs plus the margin you choose.
- The registry takes a stake of TAC to list a relay. It pays nothing and takes nothing: there is no slashing and no registry fee. The stake is yours, held
  for your `owner` address, and comes back when you leave.

## What you need

| | |
| --- | --- |
| A server | any host that runs Docker, with a public name and https. `worker-relay/Dockerfile.evm-pool-keeper` is the image. |
| An Ethereum node | `EVM_POOL_RPC_URL`: your own, or a provider's |
| A key of its own | a new key, used for nothing else: two services signing from one key race each other for its nonce. It needs ETH for gas. |
| TAC | at least the registry's minimum stake in that key, for the moment you list (1,000 TAC to start; `minStake()` on the registry says what it is now) |
| A second address | the `owner` of the stake: your own wallet, not the server's key |

## 1. Run the relay

The settings are the keeper's: see the commented `tacit-evm-pool-keeper` block in `worker-relay/render.yaml` and the header of
`worker-relay/src/evm-pool-keepers.js`. For Ethereum:

```
EVM_POOL_CHAIN_ID=1
EVM_POOL_ADDR=0x000000c2A20657CE25f2Ba99737933D031AFBEE9
EVM_POOL_ROUTER_ADDR=0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5
EVM_POOL_START_BLOCK=26069245
EVM_POOL_RPC_URL=<your node>
EVM_POOL_KEEPER_PRIV=<the relay's own key>
EVM_POOL_KEEPER_MIN_FEES=eth:20000000000000
EVM_POOL_WASM, EVM_POOL_WASM_SHA256, EVM_POOL_ZKEY, EVM_POOL_ZKEY_SHA256, EVM_POOL_VK, EVM_POOL_VK_HASH     the finalized ceremony files, by URL and pin
```

The registry wants the relay's base URL to end in `/evm-pool/keeper`. Check the relay before you list it:

```
curl https://relay.example/evm-pool/keeper/quote
```

The answer must name your key's address as `relayer`. A relay whose quote names another address is not used.

## 2. Price it

Your fee is the gas a spend costs at the moment plus your margin, and the wallet asks every relay it knows for a quote on each spend. It takes among the
relays within a quarter of the lowest fee, and a dearer one is drawn less often (its odds fall with the square of its price over the cheapest's), so a
relay priced close to the gas cost is used most. A relay that has not answered a second or so after the first has is left out of that spend.

## 3. List it

```
cd worker-relay && npm ci
RELAY_KEY=0x… node scripts/register-relay.mjs --url https://relay.example/evm-pool/keeper --owner 0x<your wallet>            # every check, nothing sent
RELAY_KEY=0x… node scripts/register-relay.mjs --url https://relay.example/evm-pool/keeper --owner 0x<your wallet> --send     # approve the stake, list the relay
```

It reads the key inside the process (or from `--key-file`), checks that the relay at the URL quotes that key's address, checks the stake and the gas, and
refuses before it sends anything if something is wrong. `--chain` lists a relay for another chain's pool (8453, 4663): the registry keeps a list for each
chain id.

The registry is at `0x00000000000299F48Fb844626ab96c6A20059a01` on Ethereum, verified on Etherscan. `list(chainId, start, max)` shows who is listed.

## What the page does with it

The Pay page reads the list for the chain in use (through a node other than the one its wallet uses), keeps the entries a wallet would use (an https URL
ending `/evm-pool/keeper` on a public name, one entry for each relay), draws a few at random next to the relay the page ships with (five relays are asked in
all), and asks each for a quote. A relay is used only if its quote names the address it was listed under and its fee is within what the user was shown.
Nothing else about a relay is trusted, and the page does not rank relays: price does. The page that lives on chain as `anon.wei` does not read the registry.

## Keeping it

The owner address manages the entry from any wallet, on the registry's Etherscan page (Write Contract):

- `topUp(id, amount)` adds stake (anyone may add to an entry)
- `setUrl(id, url)` moves the relay to another host (the owner or the relay's key)
- `startExit(id)` takes the relay off the list at once; `finishExit(id)` pays the stake to the owner once the delay (7 days to start) has passed

The minimum stake and the delay belong to the registry's owner (the Z DAO) to change, inside bounds fixed when it was deployed (250 to 25,000 TAC; 1 to 30
days), and a change takes effect two days after it is queued, so there is always time to see it. An entry whose stake falls under a raised minimum is not
shown until it is topped up. The registry's owner cannot list, remove, move or touch any entry or stake.
