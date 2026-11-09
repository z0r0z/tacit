# tacit-bot

The Tacit chain's own traffic. Two wallets, A and B, both from one seed, pay each other small amounts on the live chain, one action every 20 to 40 minutes. Its Ethereum account (A's key) brings TAC in through a signed permit, and it takes some TAC out now and then. This keeps blocks landing, runs every user path end to end against production, and adds notes to the anonymity set.

**Its traffic is synthetic.** Its blocks, payments, shields and withdrawals count in the chain's public totals, so don't quote those totals as adoption.

## No ETH, ever

The bot never sends an Ethereum transaction.

- **In:** it signs an ERC-2612 permit for a shield's inbox (the amount plus the leader's `sweepFee`). The leader sends it in with `sweepWithPermit` and takes the sweep fee in TAC.
- **Out:** a withdrawal credits `owed(account)`, and the leader pays it out (`TacitBlocks.withdraw`, `tacit-leader/leader.mjs`).

Fund it by withdrawing TAC from the Tacit chain to the account that `keygen` prints. Never send it ETH.

## Commands

```
node tacit-bot/bot.mjs keygen --out ~/tacit-bot.seed   # writes the seed (mode 600), prints only the account
BOT_SEED=$(cat ~/tacit-bot.seed) node tacit-bot/bot.mjs addresses   # account and the two chain lanes
BOT_SEED=… node tacit-bot/bot.mjs status    # balances, leader terms, the next action (read-only)
BOT_SEED=… node tacit-bot/bot.mjs run       # the loop; GET /health on $PORT
```

## What one action is

Each action starts by scanning both wallets, which picks up payments received. Then the first of these that applies runs:

1. The chain holds less than `BOT_LOW_WATER_TAC`: shield up to `BOT_SHIELD_TAC` from the account.
2. The account holds TAC back from a withdrawal: reshield it (sometimes).
3. Sometimes: withdraw 5 to 40 TAC to the account.
4. Otherwise: a payment of 0.5 to 15 TAC between A and B, usually from the richer wallet. The receiver's address is resolved through the leader's directory, and the bot checks that the receiver holds the payment once it lands. A wallet whose notes are too scattered to pay pays itself to merge two of them.

A spend still in flight when the bot restarts is kept on disk and handed to the leader again on start.

## Guards

| env | default | |
|---|---|---|
| `BOT_MIN_WAIT_MIN` / `BOT_MAX_WAIT_MIN` | 20 / 40 | jittered wait between actions |
| `BOT_MAX_IN_PLAY_TAC` | 300 | the most kept on the chain |
| `BOT_DAILY_FEE_TAC` | 25 | fees per UTC day; once spent, it waits for the next day |
| `BOT_MAX_FEE_TAC` | 1 | pause while the leader asks more than this per spend |
| `BOT_MAX_SWEEP_FEE_TAC` | 2 | no shield while the sweep fee is over this |
| `BOT_MAX_FAILURES` | 5 | stop after this many failures in a row (`/health` then shows `stopped`; restart to resume) |
| `BOT_STUCK_MIN` | 90 | unhealthy while the leader holds spends and no block has landed for this long |

It also pauses when Ethereum can't be read, when the leader doesn't answer, or when the leader is behind the landing contract. A shield is never over the leader's `shieldCap`. A pause doesn't count as a failure.

## Health

`GET /health` returns JSON with `ok`, `stopped`, `paused`, `failures`, `lastSuccess`, `lastError`, `lastAction`, `balances`, `feesToday` and `account`. It never includes a key or the seed. Each action also writes one JSON log line, with the action, `ok`, `height` landed, `proveMs`, `ms` and `fee`.

On Render a background worker has no public URL, so `/health` is only reachable on the private network (`tacit-chain-bot:8080`). Your monitor can read it from there, or from the logs.

## Recovery

Everything comes from the seed:

- **Wallets:** A and B (`HMAC-SHA256(seed, "tacit-bot-a-v1" / "tacit-bot-b-v1")`) are Tacit keys, and their chain wallets derive from them as the app's do.
- **Account:** the Ethereum account is A's own key, so A's key opened in the app shows the account, A's chain wallet, and the confidential-pool note that a shield no block took in goes back to (`giveBack`, a TAC wrap note of A's key at the bot's counter in `bot.json`).
- **State:** the files in `BOT_STATE_DIR` only save rescans and keep in-flight spends.

## Render

`render.mjs` previews every request unless `--send` is given.

```
security add-generic-password -s tacit-chain-bot-seed -a tacit -w "$(cat ~/tacit-bot.seed)"
node tacit-bot/render.mjs create --send
node tacit-bot/render.mjs secrets --service srv-… --send
node tacit-bot/render.mjs deploy --service srv-… --send
```

## Tests

```
node tests/tacit-bot.test.mjs        # scheduler, guards, budget, keys, permit
node tests/tacit-bot-e2e.test.mjs    # against tacit-block-node, real Halo2 proofs (build the node first)
```
