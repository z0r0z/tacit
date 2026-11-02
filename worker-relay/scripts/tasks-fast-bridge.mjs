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
  id: JOB, chainId: 1, opensAt, title: 'Test the fast bridge', tagline: 'Move 10 TAC from Bitcoin to Ethereum in minutes, and get paid for it.', verified: false, created: [],
  steps: [
    {
      ...steps[0], label: 'Provider', detail: 'You need 10 TAC private and a few thousand sats. Start providing with the most per bridge at 10 TAC, and keep the page open until the bridge is done.',
      action: { label: 'Provide 10 TAC', href: '/fast/#provide' }, ask: 'Provider: the Last take link under Provide liquidity',
    },
    {
      ...steps[1], label: 'Bridger', detail: 'You need 10 TAC on Bitcoin and a few thousand sats. A provider must be online first.',
      action: { label: 'Bridge 10 TAC', href: '/fast/' }, ask: 'Bridger: the Bitcoin lock link on your bridge',
    },
  ],
  about: [
    { h: 'What to do', p: 'Take one side of a 10 TAC bridge, or both sides with two keys. When it is done, claim here with its Bitcoin transaction.' },
    { h: 'What it costs', p: 'You pay the Bitcoin and network fees up front, and the reward covers them. Your TAC stays yours, less the provider\'s fee.' },
    { h: 'If a bridge stops', p: 'Open the fast bridge again after about a day and your TAC returns to your Bitcoin address.' },
    { h: 'Getting paid', p: 'Each role pays once, to the first bridge checked on both chains. Claim from the wallet you want paid, then post the link in Discord.' },
  ],
  links: [{ label: 'Discord', href: 'https://discord.gg/VxYx9XSBrM' }],
});
