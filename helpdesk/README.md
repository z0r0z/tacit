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
| `node/` | the node: `worker.mjs`, `run.sh`, `fetch.sh` |
| `*.test.mjs`, `node/worker.test.mjs` | tests (`node <file>`; Node 22) |
