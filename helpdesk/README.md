# Tacit help desk

A help desk for Tacit that runs on machines the community provides. A visitor asks a question on [tacit.finance/help](https://tacit.finance/help/); a small open model on a community machine answers it from the project's public docs.

```
visitor ──► gateway (server.mjs) ──► a community node (node/worker.mjs + llama-server) ──► answer
              │  retrieves the docs that fit the question (BM25 + embeddings),
              │  refuses what is off topic or asks for a key or seed phrase,
              └─ checks every answer before it is shown
```

The gateway holds no chat model. Nodes ask it for work (a *lease*), run the model locally and send the answer back. The gateway slips known-answer questions in among the real ones and pauses a node that fails them, vets each answer (no address, link or domain that is not in the docs), and records what each node answered.

The same nodes can also review the dapp's JavaScript in their idle time. The gateway cuts the code into small windows, nodes propose replacements, and the ones that apply and still parse are filed in an inbox (`suggestions.jsonl`) for maintainers to read. Nothing is applied or published automatically.

With `NUDGER_SECRET` set, the gateway also sends the best few of each day's new suggestions to the team's review channel (once a UTC day, through the API's `/nudger/digest`): the ones that apply and parse and change what the code does, ranked by how many reviewers agree and whether the code just changed, each credited to the reviewer's short address. The team marks each Useful, Noise or Already known, and those labels show how good the community's reviewers are.

### The review swarm

Many small machines, each doing a narrow job, check each other's work: what survives is what a person is shown. A node needs nothing new for this; a node that takes `scan` takes all of it, and what it is given looks like any other job. The roles are prompts and an answer shape (`codecheck/roles.mjs`), so any model can hold any role:

- **Scout.** Seventeen lines of the dapp around code that can hold one kind of mistake Tacit has actually made (`codecheck/lenses.mjs`): units (sats, wei, decimals), BigInt against Number, promises and swallowed failures, hex and byte order, boundaries and thresholds, untrusted text in the page, stored state, main network against test network. One question about the snippet, one finding at most, as an exact text replacement. Whole windows of code are still handed out now and then.
- **Skeptic (the judge).** Another machine, never the one that proposed the finding, is given two versions of the lines, whole (as they stand and with the proposed change, in an order the gateway chooses at random), and the code around them with those lines taken out and one marked line in their place, and picks the correct one: `A`, `B`, `same` or `unsure`. It is not told what the scout thought. Choosing the proposed text is a vote that the finding is real; choosing the other, or `same` (the change does nothing), is a vote against; and it must quote a line it relied on, which has to be in what it was shown, or the vote counts as `unsure`. Shown the code as it stands, a judge sees the old version fit and keeps it; with the lines taken out, neither version is the one already there. A yes-or-no question gets the same answer from a small model every time; a shuffled choice is only answered right by reading, and a machine that always says A, always the proposed text or always the other is right half the time and carries no weight.
- **The gateway.** Each machine's vote is weighed by how it has done on planted bugs (below) and by its size (a machine that holds a bigger model starts at 1.5); a finding is *confirmed* when `CHECK_QUORUM` weight (default 2) says real and more says real than false, and at most `CHECK_PANEL` machines (default 3) vote on one. Models differ, so a finding goes first to a machine whose model has not yet voted on it. Only confirmed findings go to the review channel, with how the skeptics voted.
- **Planted bugs.** One scout job in eight, and one skeptic job in `CHECK_EXAM_EVERY` (default 4), is an exam: a realistic mistake of the lens's own kind put into real code (`codecheck/mutate.mjs`, and it still parses), or a choice built from one (true: the code has the bug and the proposed text is the original line; false: the code is the original and the proposed text is the bug). The gateway knows the answer, so scouts are graded restored, near or miss, and skeptics right, wrong or unsure, per lens, per kind of bug, per size of machine and by whether the claim was true, with nobody reading. A machine that cannot tell true from false carries no weight. `GET /stats` shows `swarm`: findings by state and these results, and how many replies were not the JSON asked for (`invalid`, per role, lens and size of machine; the start of each is kept in `scan-exam.jsonl` to see which prompts a model cannot follow).

**Running at the size of the community.** Exam answers and votes are kept in memory as they come in (`swarmbook.mjs`) and appended to `scan-exam.jsonl` and `scan-checks.jsonl`; a lease never reads a file again, and the exam file is cut back to its newest 100,000 rows once it holds twice that. Planted bugs come from a pool made in the background (`PLANT_POOL`, default 300, one a second while it fills), since making one runs the parser in a separate process. `CHECK_SHARE` (default a half) of a node's asks try a finding to check first and the rest a snippet to review first, so a backlog of either does not stop the other. The windows looked at are written as one line a minute. A machine's vote weight comes from its last 200 graded answers, so a prompt or a model that changed is judged on what it does now. Review work earns points only while a machine's record shows it does the work: a judge at chance or worse, or a scout that has found none of its last 20 planted bugs, earns nothing for that kind of job (it may still earn for the other), and only paid work is written to the points ledger. `GET /stats` lists each address's recent record under `swarm.reviewers`.

`SWARM=0` turns it off (whole windows, no checking, every filed suggestion goes to the digest). `SCAN_PER_HOUR` (default 30) is how many review jobs one client takes an hour. A skeptic job earns `POINTS_CHECK` (default 1). Replies that are not the JSON asked for are read field by field when the model leaves quotes in its code unescaped.

## Run a node

```sh
MINER=0xYourAddress bash node/run.sh
```

`run.sh` downloads llama.cpp and the Qwen3.5-4B model (about 2.7 GB, each checked against a pinned SHA-256 before use), starts the model on `127.0.0.1:8095`, and runs `node/worker.mjs`, which takes questions from the help desk. Stop it with Ctrl-C. It needs Node 18 or newer and about 4 GB of free memory. `MINER` is the address the help desk credits the answers to.

A node already running `llama-server` elsewhere can run just the worker: `MINER=0x… LLM_URL=http://127.0.0.1:8080 node node/worker.mjs`.

## Run the gateway

```sh
node server.mjs serve                       # PORT (default 8787), community nodes only
LLM_URLS=http://127.0.0.1:8089 node server.mjs serve   # also answers from a local llama-server
```

Settings (environment):

| | |
|---|---|
| `PORT`, `HOST` | where it listens (default 8787 on 127.0.0.1) |
| `DATA_DIR` | where the ledger, the inbox, the scan cursor and the lease state live (default: this folder) |
| `ALLOW_ORIGINS` | sites allowed to call it from a browser (default tacit.finance and www) |
| `TRUST_PROXY`, `TRUST_PROXY_HOPS` | behind a proxy the client is `True-Client-IP`, else the entry that many hops from the right of `X-Forwarded-For`; `GET /whoami` shows what it sees |
| `LLM_URLS` | comma list of OpenAI-compatible servers to fall back on (empty: community nodes only) |
| `RATE_PER_MIN` | questions per client per minute (default 20) |
| `POINTS_ANSWER`, `POINTS_CANARY`, `POINTS_SCAN`, `POINTS_MAX_DAY` | points an answer, a passed check and a reviewed window earn, and the most one address or one client earns in a UTC day |
| `SCAN_REPO`, `SCAN_REF`, `SCAN_FETCH` | the checkout the code reviews read through git, its ref, and whether to `git fetch` it hourly |
| `SWARM`, `CHECK_PANEL`, `CHECK_QUORUM`, `CHECK_EXAM_EVERY`, `CHECK_SHARE`, `SCAN_PER_HOUR`, `POINTS_CHECK`, `PLANT_POOL`, `PLANT_EVERY_MS` | the review swarm (on with `SCAN_REPO`; `SWARM=0` turns it off), the machines that vote on a finding at most, the vote weight that confirms it, how often a skeptic job is an exam, the share of asks that try checking first, review jobs one client takes an hour, the points a verdict earns, and the planted-bug pool's size and how often it is topped up |
| `NUDGER_SECRET`, `NUDGER_API`, `NUDGER_HOUR_UTC`, `NUDGER_MAX` | the shared secret that turns the daily digest on (with `SCAN_REPO`), the API it goes to (default `https://api.tacit.finance`), the UTC hour it goes out from (default 6) and how many suggestions it carries (default 8); `digest-state.json` in `DATA_DIR` remembers the last day posted |
| `EMB` | `off` skips the embedding server (lexical retrieval only) |

`GET /health` says how many nodes are online, and `capacity`: those nodes by the size of model each can hold whole (`big`: a 24 GB GPU, a mid GPU with 32 GB of RAM (a "32 GB" machine reports about 31, so the line is 30), or an Apple-silicon Mac with 32 GB; `small`: the 4B; `unknown`: it has not said), with the memory they have in all.

A node tells the gateway what it has in each lease request, as `hw`: `{ ram, vram, cores, os, arch, unified }` (GB of memory, GB of GPU memory, cores, `darwin`/`linux`/`windows`, `arm64`/`x64`, whether CPU and GPU share memory). The gateway keeps numbers and those words only (`cleanHw` in lease.mjs: anything else is dropped), names no node when it reports, and times each answer itself, handed over to handed in, smoothed (`ewmaMs` in the local `/helpdesk/stats`). The tier rule (`tierOf`) comes from measurements of Qwen3.5-35B-A3B at 4 bits; a node that sends nothing is still served. `GET /helpdesk/credits?day=<UTC day>` lists what each address earned that day, in the proof pool's feed format.

## Deploy

`deploy/Dockerfile` builds the gateway and a 37 MB embedding server into one image (no chat model). `node deploy/render.mjs setup --send` creates the Render service from this repository, adds the `/help` redirect to the static site, and adds a `Cross-Origin-Embedder-Policy` rule for `/help/*` (the front page is cross-origin isolated, and such a page can only frame a document that is too, which the help panel does); without `--send` it shows what it would send; `deploy` builds the latest `main`, `status` shows the service and its `/health`. The image rebuilds the docs from the repository's current `main` at start, and serves without its FAQ if a FAQ fact no longer matches them.

Review the code-review inbox with `INBOX=/data/suggestions.jsonl node inbox.mjs`, then `mark N accepted|rejected|applied`.

## Files

| | |
|---|---|
| `server.mjs` | the gateway: guard, retrieval, prompt, leases, credits feed |
| `lease.mjs` | the lease queue, canaries, answer vetting, strikes and the points ledger |
| `retrieval.mjs`, `build-corpus.mjs`, `corpus.json` | the docs the answers come from, cut into chunks (rebuilt from the repository at start) |
| `faq.json`, `faq-check.mjs` | reviewed answers, and the check that every fact in them is in the docs they cite |
| `persona.txt` | the voice and the rules the model answers under |
| `guard.mjs` | refuses a question that holds a seed phrase |
| `scanfeed.mjs`, `codecheck/scan.mjs`, `inbox.mjs` | the code-review feed and its inbox |
| `reviewdigest.mjs` | which filed suggestions go to the review channel each day, and the poster |
| `checkfeed.mjs`, `codecheck/roles.mjs`, `codecheck/lenses.mjs`, `codecheck/mutate.mjs` | the skeptics' side and the weighted vote, the role prompts, Tacit's lenses, and the planted bugs |
| `swarmbook.mjs` | the running record of exam answers and votes: counts, weights, pay, standings |
| `node/` | the node: `worker.mjs`, `run.sh`, `fetch.sh` |
| `*.test.mjs`, `node/worker.test.mjs` | tests (`node <file>`; Node 22) |
