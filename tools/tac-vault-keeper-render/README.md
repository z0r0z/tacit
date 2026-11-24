# TAC vault keeper on Render

What it does: records the vaults' price oracle intervals (about 288 records a day, each ~0.93M gas, proven from an archive node) so that borrowing is
open and nobody has to catch up first; with VAULTS set it also watches the vaults (liquidations, auctions, alerts).

Service: a Render **background worker** (no HTTP port), Docker, `tools/tac-vault-keeper-render/Dockerfile`, Starter plan, auto-deploy off.

Environment (secrets marked):
- `KEEPER_PRIV` (secret): the keeper wallet's key. The wallet is a hot wallet holding only gas money (about 0.02 ETH a day at 0.06 gwei).
- `RPC`: an archive endpoint that serves `eth_getProof` and old headers (eth.drpc.org's free tier works but rate limits; a keyed archive endpoint is better).
- `SEND_RPC`: where transactions go (`https://ethereum-rpc.publicnode.com`).
- `ORACLE=0x0000002C48F347Fc4245226b71457E6bC85A5724,0x000000cD99De6AD4079F9e327c2A61eD58AB8551`
- `VAULTS=0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F,0x00000047bFC8cF504967049D9Cf9E1FD9651ED80` and `FROM_BLOCK=26203600` (the vaults' deploy block area).
- Gas policy: `MAX_GWEI`, `URGENT_MAX_GWEI`, `RECORD_TIP_GWEI=0.001`, `URGENT_TIP_GWEI=0.001`, `URGENT_AFTER_BLOCKS`. These are ceilings. A node refuses a send unless the
  wallet holds gasLimit x the transaction's fee cap, so each transaction offers `FEE_HEADROOM` (3) x the base fee plus the tip, or the ceiling when that is less: at
  0.05 gwei a record needs a few thousandths of an ETH in the wallet, not the 0.03 ETH that a 25 gwei ceiling would ask. A wallet that still cannot pay for a send
  raises an ALERT saying what it holds and what the send needs.
- `RECORD_MODE=demand` (recommended when the keeper's gas is not to be a standing cost): see below. Default `always`.
- `ALERT_WEBHOOK` (strongly advised): where ALERT lines are posted. Without it the alerts below are only in the log.

Recording on demand. Recording an interval later proves the same storage the same way (the oracle's ring keeps about 21 hours), so a late record is as good as a
prompt one. A borrower who finds prices missing records them in their own transaction through the router, so borrowing needs no keeper, and neither does a
withdrawal with a debt; a liquidator records first, as anyone may. With `RECORD_MODE=demand` (and `VAULTS` set) the keeper records only while a borrower is under `RISK_COVER_BPS` (28000, 280%; the
liquidation line is 200%) of cover at the lower of the venues' spot and the newest recorded price, or in an auction, and then records the whole backlog at once, so
prices are on the record before any vault can reach the line. Judging this reads only what an unrecorded oracle still answers (spot, latest, the vault's feed), which
costs no gas, and with every vault far from the line the wallet spends nothing. A catch-up from nothing is about 60 records, roughly 0.003 ETH at 0.05 gwei, so a
wallet of 0.01 to 0.02 ETH lasts through several events. While recording is off the oracle reads as dark (`TooFewSamples`), which is expected in this mode.

Funding: the keeper alerts once when the wallet holds under `LOW_BALANCE_ETH` (0.004 ETH, about 40 records at 0.06 gwei) and again when it cannot pay for a send;
a dry wallet stops recording, and borrowing pauses once an interval is late (anyone can still record it for about 21 hours, from the dapp). Set `ALERT_WEBHOOK`.

Watching the vaults. With `VAULTS` set the keeper also says (ALERT lines, and the webhook) when a vault's owner, fee recipient, TAC sink or pauser changes, when a term of
the vault or a further minter of its synth is announced (with the time it can take effect), when a vault holds SYNTH, when its ETH price feed is within a tenth of the age at
which it refuses actions, and when TAC trades more than `REDEEM_GAP_BPS` (200) over the price the vault's redemptions and bids use. It calls `absorb` only on a vault that is
short at the liquidation view, the offer view and the venues' spot alike. Optional: `PAUSE_GAP_BPS` (off at 0) with the keeper wallet named the vault's pauser pauses the
vault for `PAUSE_SECONDS` (1500) while the gap is that wide; the next pause waits as long as the last one ran.
