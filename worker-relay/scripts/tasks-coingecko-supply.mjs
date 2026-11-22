// Builds the task job for filing Tacit's CoinGecko supply update, merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//
//   node worker-relay/scripts/tasks-coingecko-supply.mjs --brief <the GitHub issue url> [--opens <unix secs>] [--tac <TAC the step pays>] [--filer <tx hash>]
//
// The same kind of job as tasks-coingecko.mjs (read that for the claim: the filer sends themselves a transaction naming the request's id, as ASCII
// padded to 32 bytes, and the step is approved after review, one call to POST /tasks/approve through tasks-approve.mjs). Here the id is the one CoinGecko
// emails for a Token Supply request (SU, then digits), and the brief is the GitHub issue that lists every input of the form. The work is longer than a
// listing request (a form of seven sections, three wallets, four allocations, two API fields and a post from the team after submitting). It pays 32 TAC,
// about $20 at TAC's price on 22 November 2026 ($0.62, after it rose about 240% in a day; the listing job paid 100 TAC when TAC was $0.19). The sum is in TAC and
// fixed, so its dollar value moves with the price. It does not depend on CoinGecko approving the update.
import { fileURLToPath } from 'node:url';
import { readJobs, writeJobs } from './tasks-merge.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE_OUT = `${root}worker-relay/src/lib/points-tasks-jobs.json`, PAGE_OUT = `${root}dapp/tasks/jobs.json`;
const JOB = 'coingecko-supply', TAC = (n) => String(BigInt(n) * 10n ** 18n), NOBODY = '0x0000000000000000000000000000000000000000';
const BRIEF = arg('brief');
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues(\/\d+)?$/.test(BRIEF ?? '')) { console.error('--brief <the GitHub issue url> is required'); process.exit(1); }

const before = readJobs(SERVICE_OUT).find((j) => j.id === JOB);
const approved = (id, name) => { const had = before?.steps.find((s) => s.id === id)?.approved ?? [], h = arg(name); return h && !had.includes(h) ? [...had, h] : had; };
const opensAt = Number(arg('opens', before?.opensAt ?? Math.floor(Date.now() / 1000)));
const pay = Number(arg('tac', 32));
const ID = '^SU[0-9]{3,}$';           // what CoinGecko's supply request ids look like (SU, then digits)
const step = { id: '01-filer', kind: 'review', to: NOBODY, gas: 22000, approved: approved('01-filer', 'filer'), minWei: TAC(pay), maxWei: TAC(pay), evidence: { text: true, pattern: ID } };

writeJobs(SERVICE_OUT, { id: JOB, chainId: 1, opensAt, steps: [step] });
writeJobs(PAGE_OUT, {
  id: JOB, chainId: 1, opensAt, title: 'Fix TAC’s supply on CoinGecko', tagline: 'File Tacit’s CoinGecko supply update with the right numbers: about 25 minutes, paid once.', verified: false, created: [],
  hint: 'Opens the brief, which lists every input of the form. Comment “claiming” on it first, file the request, then come back here and claim with the Request ID CoinGecko emails you.',
  reviewVia: { label: 'the brief', href: BRIEF },
  steps: [{
    ...step, label: 'Filer', detail: 'Files the supply update on CoinGecko with the numbers in the brief.',
    action: { label: 'Open the brief', href: BRIEF },
    ask: 'The Request ID CoinGecko emailed you (like SU12345). It is paid to the wallet you claim from.',
    input: { placeholder: 'CoinGecko Request ID', pattern: ID, text: true, error: 'That is not a CoinGecko supply Request ID (it looks like SU12345).' },
  }],
  about: [
    { h: 'What it is', p: 'TAC is on CoinGecko, but it shows about 3.08M circulating: only the public ERC-20, while most TAC is held privately on Bitcoin and in the privacy pools. A Token Supply update puts the real total and circulating figures there. CoinGecko’s form needs a logged-in account, a captcha and accepted terms, so we ask the community to file it.' },
    { h: 'What to do', p: 'Comment “claiming” on the brief so one person files it, then fill the form with the inputs it lists, section by section. Two figures change over time (the wallet balances and the circulating supply), so you read them when you submit, from links in the brief. Never pay for anything. CoinGecko emails you a Request ID, and you claim here with it. The team then posts CoinGecko’s verification post from its own account.' },
    { h: 'Paid', p: `${pay} TAC once, to the wallet you claim from, for about 25 minutes of your time. A person reads the claim first: the request exists on CoinGecko and the verification post is up with its id. It does not depend on CoinGecko approving the update.` },
    { h: 'Claiming', p: 'You claim with a transaction from your wallet to itself that names the Request ID, which this page sends. It costs a few cents of gas on Ethereum, and the reward is then claimed on the Rewards page like any other.' },
  ],
  links: [{ label: 'The brief, with every input', href: BRIEF }, { label: 'The live supply figures', href: 'https://tacit-points.onrender.com/supply' }, { label: 'Rewards', href: '/rewards/' }, { label: 'Discord', href: 'https://discord.gg/VxYx9XSBrM' }],
});
