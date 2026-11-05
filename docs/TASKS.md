# Tasks: TAC for doing a listed job

`tacit.finance/tasks` lists jobs anyone can do from their own wallet. Each step of a job (one transaction) is paid in TAC to the
account that sent it, from a budget of its own. The points service verifies and prices the steps; the page sends them.

## What a step pays

    reward = gas of the step × slow-mode gas price × TAC per ETH × (1 + tip)

kept between the step's share of the job's floor and its share of the job's cap (shares are by gas), rounded down to 0.01 TAC.

- **Gas** is measured per step (`worker-relay/scripts/tasks-jobs.mjs` runs each step on a mainnet fork), not guessed.
- **Gas price** comes from the block the step landed in: its base fee plus the tenth percentile of the tips its transactions paid
  (between 0.01 and 2 gwei). It needs nothing but the block, so it is the same whenever it is asked for.
- **TAC per ETH** is what 0.01 ETH buys on the venue that pays the most TAC for 1 ETH (Precision's band or the Tacit AMM), sampled
  every two minutes. A step is priced at the lower of the sample nearest its block (within two hours) and the median of the six
  hours before it, so a dump of TAC or a gap in the samples never raises a reward.
- **Tip, floor, cap** default to 100%, 150 TAC and 2,500 TAC per job (`POINTS_TASKS_TIP_BPS`, `_FLOOR_WEI`, `_CAP_WEI`).
- **A step's own least and most.** A step may name `minWei` and `maxWei`, which replace its share of the job's floor and cap. A step on
  a chain where gas costs next to nothing still takes the time of whoever sends it (switch chain, send, name the transaction), so it
  pays its least however cheap the gas; its most keeps a spike from paying more than the work is worth. The anon.wei job
  (`anon-wei-4`) uses 8 to 80 TAC per page chunk, 12 to 80 for the registry on Ethereum, 15 to 40 for it on each other chain and 25 to 60
  for a first point.

## How a step is credited

1. The visitor sends the step. The page names the transaction to `POST /tasks/claim` (anyone may name any transaction).
2. After 12 confirmations the service reads it from the chain and decides which steps it completed:
   - a CreateX deployment: CreateX's own `ContractCreation` log for the planned address and the chain-bound salt (the address
     commits to the init code, constructor arguments and owner, so nothing else can be there);
   - a registration in the confidential pool: the pool's `AssetRegistered` event for the planned asset;
   - a pair: a top-level call to the pool with exactly the planned call data (`createPair` reverts when the pair exists, so a
     call that succeeded made it);
   - a deployment under an open salt (`"bound": false`, a salt of 20 zero bytes and the flag `0x00`, which CreateX guards as
     `keccak256(salt)` alone): the same log, with that salt, for an address that is the same on every chain and fixed by the init code;
   - a point posted to the catch-up registry (`"kind": "post"`): the registry's own `Posted` event for a count of at least the
     step's `minSize`, so an early, trivial point is not the step.
   - a step read by hand (`"kind": "review"`): the sender's transaction to itself, naming a Bitcoin transaction in its data, once its hash is on the step's `approved` list. For work whose chain transactions are sent by someone else, such as a fast bridge swap (`worker-relay/scripts/tasks-fast-bridge.mjs`).
3. The reward is fixed then, for the account that **sent** the transaction (`tx.from`; nobody can name another account).
   It is recorded as a pending claim, once per step.
4. Each cycle a pending claim becomes a ledger adjustment (`task:<job>:<step>`), when
   - the tasks budget has room (`POINTS_TASKS_BUDGET_WEI` is a ceiling on everything ever credited),
   - it is before `POINTS_TASKS_END_SEC`, and
   - after the credit the distributor's funding still covers `POINTS_TASKS_RESERVE_DAYS` (default 2) whole days of the regular
     pot. Publishing a root is all or nothing, so a task credit must never be what holds the daily rewards back.

   A claim that waits is kept and credited later. The next root carries it; it is claimed from the distributor like any reward.

The daily split reads only that day's counted points, its budget and the rate ceiling, never the ledger, so task credits change
nobody's daily share.

## Steps on other chains

A job's steps may be on other chains than Ethereum (a step names its `chainId`; a job's own is the default). The service reads each
claim on the chain the claim names (`POST /tasks/claim` takes `{ "txHashes": […], "chainId": 8453 }`; Ethereum when it is left out),
prices its gas from that chain's own block (with its own slow-price floor, a thousand wei, not Ethereum's 0.01 gwei) in the TAC price
of Ethereum, and waits `POINTS_TASKS_MIN_AGE_SECS` (default 120) after the block as well as twelve confirmations, since a chain with
quick blocks is not final in twelve of them. Nodes: `POINTS_TASKS_RPC_8453`, `_4663` (default the service's Base and Robinhood
nodes; a comma list is tried in order). A job on a chain with no node refuses to start the service, and a node
that answers for another chain than the one it serves credits nothing.

## What the page reads

A step the service has claimed is shown as done without asking the chain (the service has read it from the chain), so a visit does not download the code
of every contract a job deployed; the steps it has not claimed are read from the chain, and a send always reads the chain. Done jobs list the newest first.
A done job with no claim says so; the account that sent it can name its transaction (`POST /tasks/claim`) and is credited like any other.

## The page's own endpoints

Under *Endpoints* at the foot of `/tasks` a reader can set nodes of their own for each chain, the rewards service and the keepers (saved in
their browser; a node is checked for its chain before it is kept). A chain with nodes of the reader's is read through them alone. The page
asks each chain for what it needs in one batched request, and a step it has seen on the chain is not asked about again.

## Turning it on

Set `POINTS_TASKS_BUDGET_WEI` (what was topped up for tasks, in wei) and `POINTS_TASKS_END_SEC` on `tacit-points`, then deploy it.
Set them in the Render dashboard only: `render.yaml` lists the two keys with `sync: false`, because a blueprint sync (any push that touches that file) writes the file's values back to the service, and a value there switched tasks off once. Both unset (or the budget 0) leaves `/tasks` answering `{ "enabled": false }` and the page closed. A job also needs an
`opensAt` in its job files: a step mined before it is never credited, and a job with none is closed.

After a top-up for tasks, raise the budget by the same amount. The root-setter's deadline is on chain (`ROOT_UPDATE_DEADLINE`);
the end must come before it.

## Adding or changing a job

`worker-relay/scripts/tasks-jobs.mjs` builds the three files from a deployment payload and its manifest (a builder replaces its own
job by id and leaves the others):

    worker-relay/src/lib/points-tasks-jobs.json   what the service verifies and prices
    dapp/tasks/jobs.json                          the same steps plus the page's copy (edit the COPY object in the script)
    dapp/tasks/tac-vaults-payload.json            the transactions a visitor sends

    node worker-relay/scripts/tasks-jobs.mjs --payload payload.json --manifest tac-vaults.json --rpc <anvil fork> --opens <unix secs>

`worker-relay/scripts/tasks-usdt-bridge.mjs` builds the `usdt-bridge-test` job: three read-by-hand steps (`kind: review`, as the fast bridge job's), each paying a fixed sum (`--tac`, 150 by default) once to the tester whose round trip of 2 USDT or more to Bitcoin and back was checked. A tester claims with the Bitcoin transaction that brought the USDT back; the page sends the account a transaction to itself naming it, and the step lists that hash after review (`--tester`, `--tester2`, `--tester3`: a push and a deploy of the points service). The job's `hint` is the page's line under the button.

`worker-relay/scripts/tasks-gen4.mjs` builds the `anon-wei-4` job (the page's chunks on Ethereum, the catch-up registry on three chains,
the first points on two) from the page build's `out/` and the registry's init code and open salt; it reads each step's gas from the
chain's own node with `eth_estimateGas` (nothing is sent). The page fetches a point from the chain's keeper when it is sent
(`GET /<chainId>/evm-pool/keeper/point`) and checks its shape against the plan.

`worker-relay/scripts/tasks-amm-route.mjs` builds the `amm-route` job: one CreateX deployment of `TacitAmmRoute` (the contract that lets the swap
page buy tacUSD and tacBTC with any token in one transaction) under an open salt, so any wallet can send it. The init code, the salt and the
address are `tests/amm-route-deploy.mjs`'s, which `dapp/swap/route.js` and the fork tests check against each other; the step pays 30 to 200 TAC (its gas at a slow price, doubled by the tip, between a least that carries the effort and a most that covers a gas spike).

A job whose contract also sits at an earlier address stays in the files as its own job (`amm-route-v1`): the service credits the account that sent that transaction like any other, once it is named to `POST /tasks/claim` (anyone may name it). The page lists it under the job it joins (`into`), so that job's result carries both payments, and the front page does not count it as work to do (`retired`). `worker-relay/tests/tasks-amm-route-v1-claim.test.mjs` claims the real transaction on a fork.

`worker-relay/scripts/tasks-token-pools.mjs` builds a job for each token pool the relay serves (`dapp/evm-pool-tokens.js` `SERVED`: USDC and
USDT): two CreateX deployments under open salts, the pool and then its router (whose constructor reads the pool), so any wallet can send them;
the code is the live TAC pool's and router's. Gas is what each step used on a fork (the pool about 0.83M, the router about 3.6M, as it deploys
its box template too); the pool step pays 20 to 70 TAC and the router step 30 to 280, so a job pays 50 to 350. A pool opened in one transaction
instead (the swap page's, Multicall3 calling CreateX twice) shows the same two CreateX logs, so whoever sent it is credited both steps once the
transaction is named to `POST /tasks/claim`. A token taken off `SERVED` takes its job with it. `tests/token-pools-tasks-fork.mjs` audits each job
on a fork: the page's check of its payload, the service's credit of each step, the deployed code against the live TAC contracts but for their
immutables, every constructor setting, and a deposit and a withdrawal with real proofs.

A change to the contracts changes the addresses: rebuild the files, run the tests and `npm run build`.

## Tests

    node worker-relay/tests/points-tasks.test.mjs                       rewards, matching, guards, store, the service
    node worker-relay/tests/tasks-page-state.test.mjs                   the page's reading of what is done, counted request by request (Chrome)
    anvil --fork-url <mainnet rpc> --port 8546 --chain-id 1
    FORK_RPC=http://127.0.0.1:8546 node worker-relay/tests/points-tasks-fork.test.mjs   all 21 steps, claimed and credited
    FORK_RPC=http://127.0.0.1:8546 node worker-relay/tests/tasks-page-e2e.mjs           the page in Chrome, wallet and all
    FORK_RPC=http://127.0.0.1:8546 node worker-relay/tests/tasks-amm-route-e2e.mjs      the amm-route job in Chrome, on a current fork
