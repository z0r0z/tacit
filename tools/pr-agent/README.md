# tacit-bot's code agent

A small open model, run by the community's idle machines, makes small code changes for the project. A person reads every one before anything is merged.

```
Discord                                         GitHub Actions (this repo)                         Community nodes
  /improve "…"                                    .github/workflows/pr-agent.yml                      run-agent.sh: llama-server with
  right-click a message > Prepare a PR   ──►      tools/pr-agent (the hands and the gates)  ──►       Qwen3.6-35B-A3B + worker.mjs
  "Prepare a fix" under a review finding          reads, edits, runs tests in a checkout              answers one agent turn at a time
  (or the daily autonomous pass)                  ▲   asks for one model turn at a time  ──►  help desk gateway  /agent/chat
        ▲                                         │                                              (leases the turn to a big node)
        └──── tacit-bot posts the outcome ◄───────┴── draft PR, or a suggestion, or "nothing"
```

## What it will and will not do

- **Outcomes.** A change that passed every check becomes a **draft** pull request. Anything else is reported in the review channel as a **suggestion** (what it found, which check said no) and never opened as a PR. A request it cannot act on gets "nothing to change". The autonomous pass says nothing at all unless it opened a PR.
- **Never** merges, approves, marks a PR ready, or edits: `contracts/`, circuits and keys, `.github/`, `package.json` and its lock, the build scripts (`build/`), the verifier keys, this tool, or `tools/noweb.cjs`. Those writes are refused by the tool and again by the checks.
- **The checks** (`gates.mjs`), all mechanical: the change is small (5 files, 150 lines), stays out of the files above, parses; any test the agent added passes **and fails without the fix** (a test that passes either way proves nothing); the existing tests that mention the changed files still pass; and a change to the dapp builds and verifies.
- **The model is not trusted.** It sees the repository and writes only where allowed. Everything it makes runs on a throwaway CI machine with a scrubbed environment (no tokens), offline. A request's text is data: links and @mentions are cleaned out of it, and the prompt says nothing in it can widen what the agent may do.
- **Nothing here pays points.** Agent turns earn nothing (`POINTS_AGENT=0`), so there is nothing to farm. Paying for turns that led to a reviewed-useful PR is a later decision.

## Pieces

| | where |
|---|---|
| the agent loop, tools, task context | `engine.mjs` |
| the checks | `gates.mjs` |
| draft PR and the report to Discord | `deliver.mjs` |
| the command line | `pr-agent.mjs` (`--task`, `--auto-touchup`, `--deliver none|pr|report|both`, `--dry-run`) |
| the CI job | `.github/workflows/pr-agent.yml` |
| Discord: `/improve`, "Prepare a PR", "Prepare a fix", `/pr-agent/report` | `worker/src/pr-agent.js` (+ routing in `index.js`, a button in `nudger.js`) |
| the model endpoint and the turn lease | `helpdesk/server.mjs` (`/agent/chat`), `helpdesk/lease.mjs` (kind `agent`) |
| a node that holds the model | `helpdesk/node/run-agent.sh`, `helpdesk/node/worker.mjs` |

## Switching it on (in this order)

1. **The gateway** (Render `tacit-helpdesk`): set `AGENT_SECRET` (64 hex characters) and `AGENT_MODELS=qwen3.6-35b-a3b`, then deploy (`node helpdesk/deploy/render.mjs deploy --send`). Check it:
   `curl -H "Authorization: Bearer $AGENT_SECRET" https://tacit-helpdesk.onrender.com/agent/status` answers `{"ok":true,"nodes":0,…}` until a big node is up. Without those two settings the endpoint does not exist.
2. **A big node.** On any machine with about 30 GB of memory and 26 GB of disk: `MINER=0x… bash helpdesk/node/run-agent.sh`. It downloads the 22 GB model (checked against a pinned SHA-256), starts it with the measured settings, and answers agent turns. `DRY_RUN=1` shows what it would do. A 6 GB GPU with 96 GB of RAM is the common case among the pool's big nodes; with no GPU it works but slowly.
3. **GitHub secrets** (Settings > Secrets and variables > Actions): `AGENT_SECRET` (the same value as the gateway's), `NUDGER_SECRET` (the API's), and optionally `PR_AGENT_PUSH_TOKEN`, a fine-grained token with Contents and Pull requests write on this repo (without it the PR is opened with the job's own token, and GitHub does not run CI on such a PR).
4. **The API** (Render `tacit-api`): set `GITHUB_DISPATCH_TOKEN` (a fine-grained token with **Actions: write** on this repo and nothing else), `IMPROVE_USER_IDS` (Discord user ids allowed to ask, comma-separated) and/or `IMPROVE_ROLE_IDS`, optionally `IMPROVE_MAX_DAY` (default 10); deploy it. With neither list set the commands answer "not enabled".
5. **Register the commands:** `cd discord && node bot.js` (this replaces the app's command list: `/verify`, `/improve`, "Prepare a PR"). The new ones start admin-only; open them under Server Settings > Integrations when you want.
6. **Try it:** Actions > "tacit-bot code agent" > Run workflow with the task left empty (an autonomous pass), then `/improve` in Discord.

Turn it off: unset `IMPROVE_USER_IDS`/`IMPROVE_ROLE_IDS` (Discord), disable the workflow (Actions), or unset `AGENT_SECRET` (the model endpoint).

## Reading how it is doing

`GET /nudger/labels` (Bearer `NUDGER_SECRET`) now has an `agent` block next to the totals: how many reports the bot posted and how many were marked Useful / Noise / Already known. Every report has those buttons. That is the measure of whether it earns its keep, and what should decide whether to loosen or tighten the checks. Every run keeps its conversation, patch and result as a workflow artifact for 30 days.

## Measured so far (2026-11-28)

See `tools/yardstick/` for the yardstick these numbers come from (223 historical fixes, each with a test that fails before and passes after).
