// Builds the task job that proves the fast bridge on mainnet with a small swap, merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//
//   node worker-relay/scripts/tasks-fast-bridge.mjs [--opens <unix secs>] [--provider <tx hash>] [--bridger <tx hash>] [--bridger2 <tx hash>]
//
// The job, finished: the first two bridges proved the fast bridge on mainnet (4 and 5 November 2026), and their bridgers are paid for it,
// each as a step of its own, once, to the claim reviewed for it (--bridger, --bridger2). The swap's Ethereum side is sent by the relay, so
// the sender of no transaction there is who did the work: a bridger sends itself a transaction naming its Bitcoin transaction, and the
// step lists that hash after review, which takes a push and a deploy of the points service. To review, a bridger's lock must be spent by a
// provider's take, with an adaptor claim settled in the pool between the two. There is no provider step: the first bridge's provider was the
// project's own, and the second's did not take part in the task.
//
// What they are paid (TAC at $0.13 and Bitcoin at $80,000 on 5 November 2026; a bridger's Bitcoin cost was 4,760 to 5,716 sats, about $4 to
// $5): the first 2,000 TAC (about $7.50 of Bitcoin fees for two locks, one stalled by bugs since fixed, and a provider's fee, about 70 TAC;
// a day of retries and reports, about 1,150 TAC; and a bonus of about 780 TAC for being first), the second 700 TAC (about $4 of fees, 35 TAC;
// about an hour and a half, 290 TAC; and a bonus of 375 TAC for a second, independent proof on another provider).
import { fileURLToPath } from 'node:url';
import { readJobs, writeJobs } from './tasks-merge.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE_OUT = `${root}worker-relay/src/lib/points-tasks-jobs.json`, PAGE_OUT = `${root}dapp/tasks/jobs.json`;
const JOB = 'fast-bridge-test', TAC = (n) => String(BigInt(n) * 10n ** 18n), NOBODY = '0x0000000000000000000000000000000000000000';

const before = readJobs(SERVICE_OUT).find((j) => j.id === JOB);
const approved = (id, name) => { const had = before?.steps.find((s) => s.id === id)?.approved ?? [], h = arg(name); return h && !had.includes(h) ? [...had, h] : had; };
const opensAt = Number(arg('opens', before?.opensAt ?? Math.floor(Date.now() / 1000)));
const step = (id, flag, tac) => ({ id, kind: 'review', to: NOBODY, gas: 22000, approved: approved(id, flag), minWei: TAC(tac), maxWei: TAC(tac) });
const steps = [step('02-bridger', 'bridger', 2000), step('03-bridger-second', 'bridger2', 700)];

writeJobs(SERVICE_OUT, { id: JOB, chainId: 1, opensAt, steps });
writeJobs(PAGE_OUT, {
  id: JOB, chainId: 1, opensAt, title: 'Test the fast bridge', tagline: 'Moving 10 TAC from Bitcoin to Ethereum in minutes: proved on mainnet on 4 and 5 November.', verified: false, created: [], done: true,
  steps: [
    { ...steps[0], label: 'Bridger, first', detail: 'The first bridge, checked on 4 November.', reserved: true, action: { label: 'Bridge 10 TAC', href: '/fast/' }, ask: 'The Bitcoin lock of your bridge. It is paid to the wallet you claim from.' },
    { ...steps[1], label: 'Bridger, second', detail: 'The second bridge, checked on 5 November.', reserved: true, action: { label: 'Bridge 10 TAC', href: '/fast/' }, ask: 'The Bitcoin lock of your bridge. It is paid to the wallet you claim from.' },
  ],
  about: [
    { h: 'What it was', p: 'Bridging 10 TAC from Bitcoin to a private balance on Ethereum, with a provider who pays it out of the pool. The bridger\'s Bitcoin is locked until the provider has paid, and comes back after about a day if it never does.' },
    { h: 'Paid', p: 'The first two bridges proved the fast bridge on mainnet, and their bridgers are rewarded for it: 2,000 TAC to the first and 700 TAC to the second. That covers their Bitcoin fees and gas and pays for their time, with a bonus for proving it out, and for the first a lock that stalled while the bugs it found were fixed. The second is credited; the first is credited when its bridger claims it here.' },
  ],
  links: [{ label: 'Discord', href: 'https://discord.gg/VxYx9XSBrM' }],
});
