# Discord holder verification

The bot uses Discord's HTTP interactions endpoint in `worker/src/index.js`.
No Gateway connection or long-running bot process is needed. `bot.js` is a
setup tool: it publishes the persistent panel, or registers the optional
`/verify` fallback.

A holder qualifies with **at least 100 TAC** in either their public Ethereum
wallet or their staked public TAC/ETH Precision farm position. Each must meet
the threshold separately. The farm's TAC balance is
`staked LP shares × pool TAC reserve / total LP supply`, rounded down, read at
one Ethereum block. Unstaked LP shares and unclaimed rewards do not count.
The existing private Bitcoin TAC proof path remains available in the Classic app.
This is a verification-time check; roles are not periodically revoked.

## Configure the API

Deploy the worker with these settings:

| Setting | Value |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Application public key from Developer Portal → General Information |
| `DISCORD_BOT_TOKEN` | Bot token |
| `TAC_ROLE_ID` | Holder role ID |
| `GOV_TAC_ERC20_MAINNET` | `0xA1313eb9f3A445606D9583bcAc3ebeB56a858279` |
| `DISCORD_VERIFY_CHANNEL_ID` | Optional: restrict panel and fallback interactions to the `#verify` channel ID |
| `DAPP_URL` | Optional, defaults to `https://tacit.finance` |

Set the application's **Interactions Endpoint URL** to
`https://api.tacit.finance/discord/interaction`. Install the bot in the server
with **View Channel**, **Send Messages**, and **Manage Roles** permissions;
the bot's highest role must sit above the holder role.

The farm and pool addresses are the same deployed mainnet contracts used by
the trade page (`dapp/trade/farm-read.js`); clients cannot supply arbitrary
contracts or self-reported farm balances.

## Publish the panel

After deploying the API and the updated dapp:

```sh
cd discord
npm ci
cp .env.example .env
# Fill DISCORD_TOKEN and DISCORD_VERIFY_CHANNEL_ID in .env.
npm run panel
```

Save the printed `DISCORD_VERIFY_MESSAGE_ID` in `.env`. Subsequent
`npm run panel` calls edit that same message; leaving it empty creates a new
panel. The setup process exits after publishing. The shared message and Verify
button stay in `#verify` across API restarts, with no timer or collector to expire.
For visibility, make `#verify` read-only for members and optionally pin the panel.

Every click returns a new **ephemeral** response visible only to that member,
with a random verification link bound to their Discord account and server. The
link expires after ten minutes; clicking the shared panel again makes a fresh
one. The panel itself never contains an individual member's link. A wallet
signature proves ownership without a transaction or token approval. The API
only consumes the link after Discord accepts the role grant, so a failed grant
can be retried.

The existing `/verify` command continues to work as a fallback. Registering it
is optional (`DISCORD_CLIENT_ID=… npm run register`).

## Checks

Run these one at a time from the repository root:

```sh
node --test-concurrency=1 tests/discord-panel.test.mjs
node tests/discord-gate.test.mjs
PLAYWRIGHT=playwright-core node tests/discord-page.mjs
```

The page test needs the Playwright Chromium headless shell installed. Tests use
mocked Ethereum and Discord endpoints; they do not publish a panel or grant live roles.
