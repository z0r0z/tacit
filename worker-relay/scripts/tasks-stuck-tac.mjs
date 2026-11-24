// Builds the task job for the stuck TAC bounty, merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//
//   node worker-relay/scripts/tasks-stuck-tac.mjs [--brief <url of the brief>] [--opens <unix secs>] [--tac <TAC the step pays>] [--entry <tx hash>]
//
// A hand-read job like tasks-coingecko-supply.mjs (read that for the claim: the entrant sends themselves a transaction naming an id, as ASCII padded to
// 32 bytes, and the step is approved after review, one call to POST /tasks/approve through tasks-approve.mjs). Here the id is the number of the entrant's
// pull request (PR, then digits). The brief is docs/STUCK-TAC-BOUNTY.md. The step pays 300 TAC, about $245 at TAC's price on 24 November 2026 ($0.82). The sum
// is in TAC and fixed, so its dollar value moves with the price. One entry is merged and takes it in full: the step is approved for that one.
import { fileURLToPath } from 'node:url';
import { readJobs, writeJobs } from './tasks-merge.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE_OUT = `${root}worker-relay/src/lib/points-tasks-jobs.json`, PAGE_OUT = `${root}dapp/tasks/jobs.json`;
const JOB = 'stuck-tac', TAC = (n) => String(BigInt(n) * 10n ** 18n), NOBODY = '0x0000000000000000000000000000000000000000';
const BRIEF = arg('brief', 'https://github.com/z0r0z/tacit/blob/main/docs/STUCK-TAC-BOUNTY.md');
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(blob\/[\w.-]+\/[\w./-]+|issues(\/\d+)?)$/.test(BRIEF)) { console.error('--brief must be a GitHub url (the brief in the repo, or an issue)'); process.exit(1); }

const before = readJobs(SERVICE_OUT).find((j) => j.id === JOB);
const approved = (id, name) => { const had = before?.steps.find((s) => s.id === id)?.approved ?? [], h = arg(name); return h && !had.includes(h) ? [...had, h] : had; };
const opensAt = Number(arg('opens', before?.opensAt ?? Math.floor(Date.now() / 1000)));
const pay = Number(arg('tac', 300));
const ID = '^PR[0-9]{1,6}$';           // the entrant's pull request: PR, then its number
const step = { id: '01-entry', kind: 'review', to: NOBODY, gas: 22000, approved: approved('01-entry', 'entry'), minWei: TAC(pay), maxWei: TAC(pay), evidence: { text: true, pattern: ID } };

writeJobs(SERVICE_OUT, { id: JOB, chainId: 1, opensAt, steps: [step] });
writeJobs(PAGE_OUT, {
  id: JOB, chainId: 1, opensAt, title: 'Bring stuck TAC back into use', tagline: `Build one way for providers to put TAC that cannot go home back to work: ${pay} TAC to the entry that is merged.`, verified: false, created: [],
  hint: 'Open the brief and pick one of its four options. Open a pull request titled “stuck TAC: your name”, then come back here and claim with its number.',
  reviewVia: { label: 'the brief', href: BRIEF },
  steps: [{
    ...step, label: 'Entry', detail: 'Opens a pull request that does one of the options in the brief, with tests.',
    action: { label: 'Open the brief', href: BRIEF },
    ask: 'The number of your pull request (like PR123). It is paid to the wallet you claim from.',
    input: { placeholder: 'Pull request number, like PR123', pattern: ID, text: true, error: 'That is not a pull request number (it looks like PR123).' },
  }],
  about: [
    { h: 'What it is', p: 'Fast bridge providers lend private TAC on Ethereum and take TAC on Bitcoin in return, and they carry it home over the regular bridge to lend it again. Two kinds of TAC on Bitcoin cannot take that road: TAC that came out of Bitcoin’s shielded pool, and TAC with more than 255 transfers behind it. A provider that takes them cannot lend that value again. This job is for a way to put that TAC back to work, or to price it so providers can take it safely.' },
    { h: 'What to do', p: 'Read the brief, pick one of its options (a desk for stuck TAC, a rebalance loop for the provider daemon, a pricing rule, or a design for a new proof rule) and open a pull request titled “stuck TAC: your name” with the code, the tests and a short write-up. Mixed entries are welcome. Nothing deployed changes, and pages and providers already running keep working.' },
    { h: 'Paid', p: `${pay} TAC once, to the wallet you claim from, for the entry that is merged. A person reads the claim first: the pull request is open and does what the brief asks. Community pledges can add to it, and the brief closes on 16 December 2026.` },
    { h: 'Claiming', p: 'You claim with a transaction from your wallet to itself that names your pull request number, which this page sends. It costs a few cents of gas on Ethereum, and the reward is then claimed on the Rewards page like any other.' },
  ],
  links: [{ label: 'The brief', href: BRIEF }, { label: 'How the fast bridge works', href: 'https://github.com/z0r0z/tacit/blob/main/docs/FAST-BRIDGE.md' }, { label: 'Rewards', href: '/rewards/' }, { label: 'Discord', href: 'https://discord.gg/VxYx9XSBrM' }],
});
