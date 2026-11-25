# stuck TAC: a desk for notes the bridge cannot follow

## What it does

A desk that swaps stuck TAC for tracked TAC on Bitcoin. A holder locks a stuck note to the desk. The desk locks tracked TAC
back. The holder claims the tracked note by key path and bridges it home with the ordinary one-transaction burn. No provider on
Ethereum is involved. The swap is the desk's existing two-lock flow (`dapp/btcswap.js`); this entry adds the three things a
provider needs to use it without holding stuck TAC itself.

First, pledges. A pledger funds the desk's tracked-TAC inventory by locking tracked TAC to a MuSig2 joint key of their key and
the desk's per-pledge key, refundable to them after 144 blocks. The desk draws from a pledge only to fund a swap at the agreed
discount, and only with the pledger's signature on that draw. The pledger runs `tools/pledge-signer.mjs`, which checks the
amount, the discount and the swap before it signs, and refuses anything else. A draw is repaid from the desk's owned tracked
TAC once the swap it funded has settled, plus a 50bps return on the drawn amount. The desk's owned inventory is spent first;
a draw is only taken when the desk is short. Undrawn TAC is reclaimable by the pledger through the script path once the refund
opens. The desk never spends an expired pledge, and never asks a pledge that refused to sign again for the same swap.

Second, a bounded discount. The discount is the haircut for TAC the bridge cannot follow, per class of stuck note: clean 0bps,
long-history 150bps, pool-exit 300bps, capped at 500bps. A quote over the cap is refused. The class comes from the note's
history, traced through `POST /reflection/burndep/trace` when the quote names the note. A quote taken without a note is the
clean rate, and the desk refuses the offer if the note turns out stuck. A holder can leave a standing sell offer; the desk
matches it when a quote's discount covers the floor. `/info` and every quote state the discount in plain numbers.

Third, a provider loop. `tools/provider-offload.mjs` runs the holder flow over a provider's stuck notes, swapping the ones whose
discount is within the provider's floor. The swap ends with a tracked note, which the provider bridges home through its normal
fast-bridge flow. A note over the floor is left alone.

The desk is listed in `dapp/fast/lp.json` and surfaced in the Bridge tab for notes the regular bridge cannot follow. The Render
service (`worker-relay/render.yaml`, `worker-relay/Dockerfile.btcswap-desk`) runs it from `btcswap-desk/config.render.json`,
which is signet. The runbook is in `btcswap-desk/README.md`.

## Assumptions

The discount schedule is a starting point, not a market price: 150bps for a long history and 300bps for a pool exit are set
from the cost of holding TAC that cannot bridge, and the 500bps cap is the most the desk will ever take. The provider's floor
is the binding limit; the desk's cap is the backstop.

A drawn pledge is repaid from the desk's capital, not from the swap's proceeds. The desk converts tracked TAC into stuck TAC,
so its tracked inventory only drains. A swap that draws from a pledge consumes the desk's owned inventory, leaving it near
zero after the swap. A pledger should treat a draw as a loan to the desk's balance sheet, repaid from its capital (an operator
top-up, or tracked TAC the desk holds beyond the swap). The return is 50bps of the drawn amount.

The class of a note comes from the trace endpoint's bundle. A pool exit is read from an opcode in the bundle's leaves; a history
over 255 transfers is read from the hop count. The trace endpoint is served by the Tacit API, not this repo, so the exact bundle
fields are the API's.

## Numbers

A provider bridging one 100-TAC note per bridge, 5% of notes stuck, desk fee 30bps plus 1 TAC, return 50bps. The table is
printed by `tests/btcswap-numbers.test.mjs`, not computed by hand.

| discount | N   | ETH-side TAC with desk | ETH-side TAC without | stuck TAC with desk | stuck TAC without |
|----------|-----|------------------------|----------------------|---------------------|--------------------|
| 1%       | 20  | 1997.7                 | 1900.0               | 0.0                 | 100.0              |
| 1%       | 50  | 4995.4                 | 4800.0               | 0.0                 | 200.0              |
| 1%       | 100 | 9993.1                 | 9700.0               | 0.0                 | 300.0              |
| 3%       | 20  | 1995.7                 | 1900.0               | 0.0                 | 100.0              |
| 3%       | 50  | 4991.4                 | 4800.0               | 0.0                 | 200.0              |
| 3%       | 100 | 9987.1                 | 9700.0               | 0.0                 | 300.0              |

With the desk the provider never holds stuck TAC, and holds more on Ethereum at every N and discount. Without it the stuck TAC
waits for a new pool generation, which the brief does not promise.

## Risks

The desk holds stuck TAC after every swap, and its tracked inventory drains. If no pledgers fund it and the operator does not
top it up, the desk stops quoting. A pledger's draw is repaid only when the desk holds owned tracked TAC; a desk with no
capital cannot repay, and the pledge's script-path refund only returns what was never drawn.

The discount is a guess at the haircut. If the market values stuck TAC below the desk's rate, the desk accumulates notes it
cannot sell at a profit. The cap limits the damage per swap, not the total.

A holder who stops after the desk locks costs the desk its lock until its timelock runs; the refund is a script-path spend, so
that TAC comes back untracked.

## What was not tested

The desk has never been deployed to Render, and no live signet run has happened. The signet asset id in
`btcswap-desk/config.render.json` is not filled in: the signet TAC Bitcoin asset id is not published in this repo (the mainnet
one is `tacAssetId` in `contracts/deployments/1.json`), and it must be filled in before a live signet swap. The trace endpoint
has not been called against the live Tacit API from the desk server. The pledger signer has not been run as a standalone
process against a live desk. The sim tests cover the pledge, discount, floor and provider flows against a simulated Bitcoin;
the reflection's fold of a pledge draw is not covered, and neither is a live signet swap.

## Tests

[test results to be filled in once the full suite has run]
