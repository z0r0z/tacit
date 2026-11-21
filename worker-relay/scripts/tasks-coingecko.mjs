// Builds the task job for filing Tacit's CoinGecko listing request, merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//
//   node worker-relay/scripts/tasks-coingecko.mjs [--opens <unix secs>] [--tac <TAC the step pays>] [--filer <tx hash>]
//
// The work is done on CoinGecko's site, so no transaction names who did it. The filer sends themselves a transaction naming the request's
// id (what CoinGecko emails them, like CL12345, as its ASCII bytes padded to 32; dapp/tasks/review.js), which the page does, and the step
// lists that hash after review: the request exists, it was filed from the project's verification post, and the project's account replied
// to that post with the id. The service only credits an id that looks like CoinGecko's (`evidence`). Approving a claim is one call to
// POST /tasks/approve (worker-relay/scripts/tasks-approve.mjs): no push, no deploy, and the service names the claim itself; `--filer` still
// lists a hash in the job file, which takes a push and a deploy.
// The step pays once, a fixed sum, to the wallet that claimed. 100 TAC (about $19 at TAC's $0.19 on 18 November 2026): about fifteen
// minutes of someone's time on a free account, nothing to pay, so a small sum for the bother. It does not depend on CoinGecko approving.
import { fileURLToPath } from 'node:url';
import { readJobs, writeJobs } from './tasks-merge.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE_OUT = `${root}worker-relay/src/lib/points-tasks-jobs.json`, PAGE_OUT = `${root}dapp/tasks/jobs.json`;
const JOB = 'coingecko-listing', TAC = (n) => String(BigInt(n) * 10n ** 18n), NOBODY = '0x0000000000000000000000000000000000000000';
const BRIEF = 'https://github.com/z0r0z/tacit/issues/87';
const POST = 'https://x.com/tacitfi/status/2122997312071033001';

const before = readJobs(SERVICE_OUT).find((j) => j.id === JOB);
const approved = (id, name) => { const had = before?.steps.find((s) => s.id === id)?.approved ?? [], h = arg(name); return h && !had.includes(h) ? [...had, h] : had; };
const opensAt = Number(arg('opens', before?.opensAt ?? Math.floor(Date.now() / 1000)));
const pay = Number(arg('tac', 100));
const ID = '^CL[0-9]{3,}$';           // what CoinGecko's request ids look like (CL, then digits)
const step = { id: '01-filer', kind: 'review', to: NOBODY, gas: 22000, approved: approved('01-filer', 'filer'), minWei: TAC(pay), maxWei: TAC(pay), evidence: { text: true, pattern: ID } };

writeJobs(SERVICE_OUT, { id: JOB, chainId: 1, opensAt, steps: [step] });
writeJobs(PAGE_OUT, {
  id: JOB, chainId: 1, opensAt, title: 'List TAC on CoinGecko', tagline: 'File Tacit’s CoinGecko listing request for TAC: about fifteen minutes, paid once.', verified: false, created: [],
  hint: 'Opens the brief, which has every field. Comment “claiming” on it first, file the request, then come back here and claim with the Request ID CoinGecko emails you.',
  reviewVia: { label: 'the brief', href: BRIEF },
  steps: [{
    ...step, label: 'Filer', detail: 'Files the request on CoinGecko from the team’s verification post.',
    action: { label: 'Open the brief', href: BRIEF },
    ask: 'The Request ID CoinGecko emailed you (like CL12345). It is paid to the wallet you claim from.',
    input: { placeholder: 'CoinGecko Request ID', pattern: ID, text: true, error: 'That is not a CoinGecko Request ID (it looks like CL12345).' },
  }],
  about: [
    { h: 'What it is', p: 'TAC is not on CoinGecko yet. Their request form needs a logged-in account, a captcha and the terms accepted by a person, so we ask the community to file it. The team has already published the verification post CoinGecko requires, and replies to it with your Request ID.' },
    { h: 'What to do', p: 'Comment “claiming” on the brief so one person files it, then follow its steps: every field is written out, ready to paste, and it takes about fifteen minutes with a free CoinGecko account. Choose the free Regular Pass and never pay for anything. CoinGecko emails you a Request ID, and you claim here with it.' },
    { h: 'Paid', p: `${pay} TAC once, to the wallet you claim from, for about fifteen minutes of your time. A person reads the claim first: the request exists on CoinGecko, it was filed from the verification post, and the team’s account has replied to it with the id. It does not depend on CoinGecko approving the listing.` },
    { h: 'Claiming', p: 'You claim with a transaction from your wallet to itself that names the Request ID, which this page sends. It costs a few cents of gas on Ethereum, and the reward is then claimed on the Rewards page like any other.' },
  ],
  links: [{ label: 'The brief, with every field', href: BRIEF }, { label: 'The verification post', href: POST }, { label: 'Rewards', href: '/rewards/' }, { label: 'Discord', href: 'https://discord.gg/VxYx9XSBrM' }],
});
