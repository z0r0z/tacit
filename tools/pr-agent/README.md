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

## Switching it on

Merging this changes nothing by itself: the model endpoint does not exist without `AGENT_SECRET` and `AGENT_MODELS`, the Discord commands say "not enabled" without `IMPROVE_USER_IDS`/`IMPROVE_ROLE_IDS`, and the daily pass stays off until the repository variable `PR_AGENT_ON` is `true`.

**One command does most of it** (it shows its plan unless you add `--send`, and it refuses before this is on main):
`node tools/pr-agent/ship.mjs --users <discord user ids> --send`
It makes the gateway secret (kept in the keychain as `tacit-agent-secret`), sets `AGENT_SECRET`/`AGENT_MODELS` on `tacit-helpdesk` and `GITHUB_DISPATCH_TOKEN`/`IMPROVE_USER_IDS` on `tacit-api`, sets the GitHub secrets `AGENT_SECRET` and `NUDGER_SECRET` and the variable `PR_AGENT_ON`, and deploys both services.

What only a person can do:
1. **Before `ship.mjs`:** create a fine-grained GitHub token for this repo with **Actions: write** and nothing else (GitHub only lets a person make one) and keep it as `tacit-pragent-dispatch-token` in the keychain: `security add-generic-password -U -s tacit-pragent-dispatch-token -a $USER -w`. Optionally also a `PR_AGENT_PUSH_TOKEN` secret (Contents and Pull requests write): without it the PR is opened with the job's own token and GitHub does not run CI on such a PR.
2. **After it:** register the commands: `cd discord && node bot.js` from the checkout that has `discord/.env` (this replaces the app's command list: `/verify`, `/improve`, "Prepare a PR"; the new two start admin-only, open them under Server Settings > Integrations when you want).
3. **A big node.** On a machine with about 30 GB of memory and 26 GB of disk: `MINER=0x… bash helpdesk/node/run-agent.sh`. It downloads the 22 GB model (checked against a pinned SHA-256), starts it with the measured settings and answers agent turns (`DRY_RUN=1` shows what it would do). A 6 GB GPU with 96 GB of RAM is the common case among the pool's big nodes; with no GPU it works, slowly. `curl -H "Authorization: Bearer $AGENT_SECRET" https://tacit-helpdesk.onrender.com/agent/status` counts the nodes that can take a turn.
4. **Try it:** Actions > "tacit-bot code agent" > Run workflow with the task left empty (an autonomous pass), then `/improve` in Discord.

Turn it off: unset `IMPROVE_USER_IDS`/`IMPROVE_ROLE_IDS` (Discord), set `PR_AGENT_ON` to anything else (the daily pass), or unset `AGENT_SECRET` (the model endpoint).

## Reading how it is doing

`GET /nudger/labels` (Bearer `NUDGER_SECRET`) now has an `agent` block next to the totals: how many reports the bot posted and how many were marked Useful / Noise / Already known. Every report has those buttons. That is the measure of whether it earns its keep, and what should decide whether to loosen or tighten the checks. Every run keeps its conversation, patch and result as a workflow artifact for 30 days.

## What is and is not known about the model

The checks, the safety rules and the plumbing are tested (about 250 checks across the gateway, the node, the runner and the Discord side, including a real push to a remote and a draft PR through a stand-in for `gh`). **How often the open model gets a change right is not established; the samples are small.**

Replaying 223 real historical fixes (each with a test that fails before and passes after), the first runs solved none: the 4B model the pool runs today 0/34, Qwen3.6-35B-A3B 0/21, Qwen3-Coder-Next 0/21. Those runs had mistakes in the test harness (the failing tests were shown to the model but not on disk, so it could not reproduce the failure, and the turn budget was starved), found and fixed since. After the fixes Qwen3.6-35B-A3B solved its first real item (a nullifier list saved as its length; a 4-line change) within the first two items of the rerun, on the last of its 30 allowed turns. That is one solve in two items, not a rate. The runner's own budget is 40 turns, and reads return at least 100 lines because the model otherwise spends its turns reading 20 at a time.

So expect most outcomes at first to be a suggestion or "nothing to change". That is by design: failing gates cost nothing but idle electricity, and the Useful / Noise / Already known labels on every report are what will say whether to loosen or tighten the checks. The yardstick itself (`tools/yardstick`, with its data and what building it taught) is on the `yardstick` branch and not part of this change.
