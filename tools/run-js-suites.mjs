// Runs the worker and relay JS suites, in parallel, with a per-suite timeout — the gate behind .github/workflows/js-suites.yml.
//
//   node tools/run-js-suites.mjs                     every suite not skipped
//   node tools/run-js-suites.mjs --jobs 4            how many at once (default: as many as there are cores, capped at 8)
//   node tools/run-js-suites.mjs --timeout 180       seconds per suite (default 120)
//   node tools/run-js-suites.mjs --offline           cut the suites off from the internet (what CI does)
//   node tools/run-js-suites.mjs --list              print what would run, and what is skipped and why
//   node tools/run-js-suites.mjs tests/foo.test.mjs  just these
//
// WHY A SKIP LIST AND NOT A LIST OF WHAT TO RUN: on 2026-11-16 two suites had been failing for weeks unnoticed
// (tests/relay-self-funding.test.mjs for six, since a policy it asserted changed; tests/free-relay-cheap-gas.test.mjs
// because one case's gas price answered the next one's). Both were rot, not bugs — nothing ran them. A list of suites
// to RUN rots the same way: a new suite is only covered if someone remembers to add it. So everything matching the
// patterns below runs, and a suite leaves the gate only by being named in SKIP with a reason.
import { readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOWEB = join(ROOT, 'tools', 'noweb.cjs');

// The suites the gate covers: worker-relay's own, and the tests/ suites that exercise worker or relay source.
const DIRS = [join(ROOT, 'worker-relay', 'tests'), join(ROOT, 'tests')];

// Skipped, each with the reason it cannot sit in a push gate. Keep the reason: it is what tells a later reader whether
// the suite can come back. A suite that is merely SLOW does not belong here — raise --timeout instead.
const SKIP = new Map(Object.entries({
  // Need a real Chrome at a macOS path and bind a fixed port, so they cannot run on a Linux runner and collide when
  // run beside each other. Run them locally: node worker-relay/tests/tasks-gen4-page.test.mjs
  'worker-relay/tests/tasks-gen4-page.test.mjs': 'browser test: needs a local Chrome, binds a fixed port',
  'worker-relay/tests/tasks-page-state.test.mjs': 'browser test: needs a local Chrome, binds a fixed port',
  // Need the live chain or a public node: each was measured both with the internet and without (2026-11-16), and these
  // are the ones that cannot pass offline. A suite here is not a verdict on a diff.
  'worker-relay/tests/btc-pool-relayer.test.mjs': 'live Bitcoin/pool endpoints: ran 23 min offline before being killed',
  'tests/btc-pool-indexer.test.mjs': 'live Bitcoin endpoints: hangs offline',
  'tests/btc-pool-zap.test.mjs': 'live Bitcoin endpoints: hangs offline',
  'tests/capacity-monitoring.test.mjs': 'reads a live endpoint: fails at once offline',
  'tests/pool-swap-carrier.test.mjs': 'live endpoints: passes online in ~2 min, hangs offline',
  // Passes offline, but only by soft-skipping every live check, so in this gate it would assert nothing. It is a
  // mainnet canary and canary.yml runs it on its own schedule, where an unreachable host is inconclusive, not a failure.
  'tests/canary-asset-tac-mainnet.test.mjs': 'live mainnet canary — run by canary.yml; offline it skips its checks',
  // Start `anvil --fork-url <a public node>`, so they need the internet by construction and cannot be part of an offline
  // gate. (A BARE anvil is fine and does run here — see the Foundry step in the workflow — so this is about the fork, not
  // the binary.) They want a job with network of their own; until then they run locally.
  'worker-relay/tests/evm-pool-keeper-send.test.mjs': 'anvil --fork-url: forks mainnet, so it cannot run offline',
  'worker-relay/tests/tasks-gen4-fork.test.mjs': 'anvil --fork-url: forks mainnet, so it cannot run offline',
  'tests/checkpoints-admin.test.mjs': 'anvil --fork-url: forks mainnet, so it cannot run offline',
  // Passes offline every time, but takes 130–175 s on the machine this was measured on, which leaves no headroom under
  // any per-suite cap a slower runner could meet. Not broken and not flaky — just too slow to gate on. It comes back by
  // getting faster, or by being run with a longer --timeout outside the push gate.
  'tests/btc-pool-wallet.test.mjs': 'passes offline but runs 130-175 s: no headroom under the gate cap',
}));

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const has = (name) => process.argv.includes(name);
const JOBS = Math.max(1, Number(arg('--jobs', Math.min(8, Math.max(2, cpus().length)))));
const TIMEOUT = Math.max(10, Number(arg('--timeout', 120))) * 1000;
const OFFLINE = has('--offline');

const named = process.argv.slice(2).filter((a) => /\.mjs$/.test(a) && !a.startsWith('--'));
const discovered = DIRS.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.test.mjs')).map((f) => relative(ROOT, join(d, f))) : []));
// A tests/ suite is in scope when it exercises worker or relay source; worker-relay's own suites always are.
const inScope = async (rel) => {
  if (rel.startsWith('worker-relay/')) return true;
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(join(ROOT, rel), 'utf8').catch(() => '');
  return /worker\/src|worker-relay\/src/.test(src);
};

const all = named.length ? named : (await Promise.all(discovered.map(async (r) => ((await inScope(r)) ? r : null)))).filter(Boolean);
const run = all.filter((r) => !SKIP.has(r)).sort();
const skipped = all.filter((r) => SKIP.has(r)).sort();

if (has('--list')) {
  console.log(`${run.length} suites would run:`);
  for (const r of run) console.log('  ' + r);
  console.log(`\n${skipped.length} skipped:`);
  for (const r of skipped) console.log(`  ${r}  — ${SKIP.get(r)}`);
  process.exit(0);
}

console.log(`${run.length} suites, ${JOBS} at a time, ${TIMEOUT / 1000}s each${OFFLINE ? ', offline' : ''} (${skipped.length} skipped)`);

// A suite under worker-relay/ resolves its imports against worker-relay/node_modules, so run it from there.
const one = (rel) => new Promise((done) => {
  const wr = rel.startsWith('worker-relay/');
  const args = [...(OFFLINE ? ['--require', NOWEB] : []), '--test', wr ? rel.replace('worker-relay/', '') : rel];
  const t0 = Date.now();
  const p = spawn(process.execPath, args, { cwd: wr ? join(ROOT, 'worker-relay') : ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const kill = setTimeout(() => { p.kill('SIGKILL'); }, TIMEOUT);
  p.on('close', (code, signal) => {
    clearTimeout(kill);
    const secs = Math.round((Date.now() - t0) / 1000);
    done({ rel, secs, ok: code === 0, timedOut: signal === 'SIGKILL', out });
  });
});

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(JOBS, run.length) }, async () => {
  for (;;) {
    const i = next++;
    if (i >= run.length) return;
    const r = await one(run[i]);
    results.push(r);
    // One line per suite as it lands, so a CI log shows progress rather than a silent wait.
    console.log(`${r.ok ? 'ok  ' : r.timedOut ? 'TIME' : 'FAIL'}  ${String(r.secs).padStart(3)}s  ${r.rel}`);
  }
}));

const bad = results.filter((r) => !r.ok).sort((a, b) => (a.rel < b.rel ? -1 : 1));
if (bad.length) {
  console.log(`\n${'='.repeat(70)}\n${bad.length} of ${results.length} suites did not pass:\n`);
  for (const r of bad) {
    console.log(`── ${r.rel}${r.timedOut ? ` (killed after ${TIMEOUT / 1000}s)` : ''}`);
    const all = r.out.split('\n');
    const lines = all.filter((l) => /^not ok|error:|AssertionError|Error:|^# (fail|pass)/.test(l.trim()));
    // A file-level "not ok 1 - /path/to/suite" with `error: 'test failed'` is node reporting that the file failed and
    // says nothing about WHY, so matching those lines alone can hide the cause completely — it did on this gate's first
    // run, where two suites reported only "test failed". When nothing matched names a cause, print the tail instead.
    const named = lines.some((l) => /AssertionError|Error:(?! 'test failed')|^not ok \d+ - (?!\/)/.test(l.trim()));
    for (const l of lines.slice(0, 12)) console.log('   ' + l.trim().slice(0, 200));
    if (!named) {
      const tail = all.filter((l) => l.trim() && !/^(ok|# (Sub|tests|pass|fail|cancel|skip|todo|dura))/.test(l.trim())).slice(-20);
      console.log('   ── its output (nothing above named a cause):');
      for (const l of tail) console.log('      ' + l.trim().slice(0, 200));
    }
    console.log('');
  }
}
const slow = results.filter((r) => r.secs >= 60).sort((a, b) => b.secs - a.secs);
if (slow.length) console.log(`slowest: ${slow.slice(0, 5).map((r) => `${r.rel} ${r.secs}s`).join(', ')}`);
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
