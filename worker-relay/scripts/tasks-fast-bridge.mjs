// Builds the task job that proves the fast bridge on mainnet with a small swap, merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//
//   node worker-relay/scripts/tasks-fast-bridge.mjs [--opens <unix secs>] [--provider <tx hash>] [--bridger <tx hash>]
//
// The job: two roles of one swap, each paid once. The swap's Ethereum side is sent by the relay, so the sender of no transaction there is
// who did the work: each role sends itself a transaction naming its Bitcoin transaction, and the step lists that hash after review
// (--provider, --bridger), which takes a push and a deploy of the points service. To review, a bridger's lock must be spent by a provider's
// take, with an adaptor claim settled in the pool between the two.
//
// Each role pays 60 TAC, about twice the fees of one swap (about 10,000 sats and a little gas) at the fee levels of November 2026.
import { fileURLToPath } from 'node:url';
import { readJobs, writeJobs } from './tasks-merge.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE_OUT = `${root}worker-relay/src/lib/points-tasks-jobs.json`, PAGE_OUT = `${root}dapp/tasks/jobs.json`;
const JOB = 'fast-bridge-test', PAYS = String(60n * 10n ** 18n), NOBODY = '0x0000000000000000000000000000000000000000';

const before = readJobs(SERVICE_OUT).find((j) => j.id === JOB);
const approved = (id, name) => { const had = before?.steps.find((s) => s.id === id)?.approved ?? [], h = arg(name); return h && !had.includes(h) ? [...had, h] : had; };
const opensAt = Number(arg('opens', before?.opensAt ?? Math.floor(Date.now() / 1000)));
const step = (id) => ({ id, kind: 'review', to: NOBODY, gas: 22000, approved: approved(id, id.slice(3)), minWei: PAYS, maxWei: PAYS });
const steps = [step('01-provider'), step('02-bridger')];

writeJobs(SERVICE_OUT, { id: JOB, chainId: 1, opensAt, steps });
writeJobs(PAGE_OUT, {
  id: JOB, chainId: 1, opensAt, title: 'Test the fast bridge', tagline: 'One small swap from Bitcoin to Ethereum, in minutes.', verified: false, created: [],
  steps: [
    { ...steps[0], label: 'Provider', detail: 'Hold 10 TAC private and a few thousand sats. Set the most per bridge to 10 TAC and keep the page open until the bridge is done.', ask: 'Your take: the Bitcoin transaction that took the lock' },
    { ...steps[1], label: 'Bridger', detail: 'Hold 10 TAC on Bitcoin and a few thousand sats. Bridge 10 TAC.', ask: 'Your lock: the Bitcoin transaction that locked your TAC' },
  ],
  about: [
    { h: 'What it does', p: 'Proves the fast bridge on mainnet with one real swap of 10 TAC. One person can take both roles, or two people can meet on the page.' },
    { h: 'What it costs', p: 'You pay the Bitcoin and network fees up front, and the reward covers them. Your TAC stays yours, less the provider\'s fee.' },
    { h: 'If a bridge stops', p: 'Your Bitcoin comes back on its timelock, after about a day. Use 10 TAC only.' },
    { h: 'How it pays', p: 'Each role pays once, for the first swap reviewed on both chains. Claim from the wallet to be paid, then post the link in Discord.' },
  ],
  links: [{ label: 'The fast bridge', href: '/fast/' }],
});
