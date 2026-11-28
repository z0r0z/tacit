# The yardstick

How well can a model make a small change to this repository? 223 real changes from the project's own history, each with a test that **fails on the parent commit and passes on the fix** (twice, to rule out flaky tests), so a model's answer is graded by the project's own tests and not by anyone's opinion. The changes are recent, so a model trained before them cannot have memorised the answers.

```
mine.mjs      candidate commits since 2026-08-01: in-scope source + a test changed together   (git log only)
clone.sh      a throwaway sparse checkout that shares your repo's objects (your tree is never touched)
validate.mjs  keeps a candidate only if its tests pass on the fix and fail on the parent, twice (offline, low priority)
split.mjs     data/dev.jsonl (108) and data/sealed.jsonl (115), split by a hash of the commit id: sealed items are only ever scored, never read while tuning
agent.mjs     the model arm: a tool-calling loop (read, search, edit, run a test) against any OpenAI-style server; --oracle applies the real fix instead, to check the grader
report.mjs    per-model results; dev items one by one, sealed items as totals only
agent.test.mjs  the loop against a scripted fake model (compaction, repeated-call guard, transcripts)
```

**Run `agent.mjs` only in a throwaway checkout on a throwaway machine:** the model's edits and the tests it runs execute there.

Three ways to pose an item: `symptom` (the one-line request only; the tests are hidden and grade the result), `tests-given` (the failing tests are on disk and in the prompt: a red CI run), and `--hints` (also shows the source files the failing tests import: where a finding or a touch-up task would already point). 152 of the 223 can be posed as `symptom`; the others need a symbol the fix introduces, which nobody could guess.

`data/oracle-unsolved.txt`: the real fix was applied through the grader on the test machine for the first 76 items, and 73 passed; these 3 did not (they depend on the machine) and are excluded from every score. The other 147 have not had that check yet.

## What building it taught (each of these produced a false zero before it was fixed)

1. **A model must be able to run the failing test.** In `tests-given` the failing tests were in the prompt but the checkout was at the parent commit, where the old, passing test files were on disk. The model ran them, saw them pass, and reported "already passes, no changes needed". Every `tests-given` zero before the fix measured a setup that could not be solved. The commit's tests now go on disk before the model starts.
2. **Prompt reading dominates, not generating.** An agent turn re-reads a growing conversation. For a mixture-of-experts model with its experts in system RAM, `-b 2048 -ub 2048` lets big prompts use the GPU: prompt processing went from ~230 to 630-900 tokens/s (3-4x) for a few hundred MB of VRAM.
3. **The window fills with old tool output**, ending runs for a limit the harness set. Past ~60% full, all but the last four tool results are cut to a line each (the saved transcript keeps everything).
4. **Models read 20 lines at a time** and spend the whole budget reading. A read now returns at least 100 lines. (The turn budget matters: the first solve below came on turn 30 of 30. A launcher script of mine silently overrode the 45 turns I had asked for with its own 30, because the loop reads the first copy of a flag; the launcher now puts the caller's flags first.)
5. A stale keep-alive socket makes Node's `fetch` throw before anything reaches the server (6 of the 4B's first 20 attempts). Connection errors are retried.
6. Concurrent model servers share one CPU: three at once made each run at a quarter of its speed. Measure one at a time.

## Measured so far (2026-11-28, small samples)

Models run with their experts in system RAM and attention on the GPU (about 3.4 GB of VRAM, the shape of the pool's 6 GB-GPU, 96 GB-RAM nodes), on a 16-core server CPU, so speeds are an upper bound for a laptop.

- **Qwen3.6-35B-A3B**, alone: decode ~39 tokens/s, prompts ~800 tokens/s with big batches.
- **Before the fixes** (items posed so they could not be solved, or with the starved budget): the 4B model the pool runs today 0/34 attempts (6 more were server errors and are not counted), Qwen3.6-35B-A3B 0/21, Qwen3-Coder-Next 0/21, across symptom, tests-given and hints runs. Read these as "the setup was wrong", not as the models' ability.
- **After the fixes:** Qwen3.6-35B-A3B **solved its first real item** (the bug where a nullifier list was stored as its length; a 4-line change, about 3 minutes, on turn 30 of 30) within the first two items of the rerun (the other item: 73 changed lines, not solved). The rerun is continuing; Qwen3-Coder-Next and the 4B have not been re-run under the fixed setup. Nobody should quote a solve rate from n=2.

The number to watch is the share of attempts that pass the hidden tests (`pass@1`) and the share that pass in any of several attempts (`pass@k`): because a pass is mechanical, a community running many attempts in idle time turns a modest pass@1 into candidate changes for a person to review (see `tools/pr-agent`).
