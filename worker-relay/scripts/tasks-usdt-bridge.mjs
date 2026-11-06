// Builds the task job that proves the USDT bridge on mainnet with a small round trip, merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//
//   node worker-relay/scripts/tasks-usdt-bridge.mjs [--opens <unix secs>] [--tac <TAC a step pays>] [--tester <tx hash>] [--tester2 <tx hash>] [--tester3 <tx hash>] [--tester4 <tx hash>]
//
// A tester takes about 5 USDT (a small amount is the point and a larger one pays no more; the relay's fee follows gas, from about 1 to 3 USDT on 6 November 2026 (1.3 at 0.9 gwei, 3.1 at 1.7), so less than that
// cannot cross and 5 leaves 2 to 4 on Bitcoin) from its wallet to Bitcoin and back: made private in the pool, burned there, minted on Bitcoin by its own key, burned on
// Bitcoin and minted in the pool again. Nothing on Ethereum is sent by the work's owner, so no transaction names who did it: the tester sends itself a transaction naming
// the Bitcoin transaction that brought the USDT back (its burn), which the page does, and the step lists that hash after review (a push and a deploy of the points
// service). The review checks the burn on Bitcoin (a bridge burn of the USDT id, spending a note a cross-out minted for the tester's key) and the mint it paid on Ethereum.
// Each step pays once, as the fast bridge job's did, a fixed sum. 250 TAC (TAC at $0.13, ETH at $2,400 and Bitcoin at $80,000 on 6 November 2026): about $6 of fees (Ethereum gas for
// the approval and the deposit, about $1; the relay's fee for the way out, 1 to 3 USDT, the way back being free; about 2,500 sats of Bitcoin for the two Bitcoin steps, about $2), about 50 TAC, and the rest
// for the tester's time, an hour or so of attention spread over the day the bridge takes, at the rate the fast bridge job paid.
import { fileURLToPath } from 'node:url';
import { readJobs, writeJobs } from './tasks-merge.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE_OUT = `${root}worker-relay/src/lib/points-tasks-jobs.json`, PAGE_OUT = `${root}dapp/tasks/jobs.json`;
const JOB = 'usdt-bridge-test', TAC = (n) => String(BigInt(n) * 10n ** 18n), NOBODY = '0x0000000000000000000000000000000000000000';

const before = readJobs(SERVICE_OUT).find((j) => j.id === JOB);
const approved = (id, name) => { const had = before?.steps.find((s) => s.id === id)?.approved ?? [], h = arg(name); return h && !had.includes(h) ? [...had, h] : had; };
const opensAt = Number(arg('opens', before?.opensAt ?? Math.floor(Date.now() / 1000)));
const pay = Number(arg('tac', 250));
const step = (id, flag) => ({ id, kind: 'review', to: NOBODY, gas: 22000, approved: approved(id, flag), minWei: TAC(pay), maxWei: TAC(pay) });
const steps = [step('01-tester', 'tester'), step('02-tester-second', 'tester2'), step('03-tester-third', 'tester3'), step('04-tester-fourth', 'tester4')];
const ASK = 'The Bitcoin transaction that brought your USDT back (its burn). It is paid to the wallet you claim from.';
const ACTION = { label: 'Bridge 5 USDT', href: '/#card=bridge:wusdt&amt=5' };
// The places held on 6 November 2026 for the testers in line: the account that claimed (the sender of a transaction to itself naming a Bitcoin transaction of its
// round trip) and that transaction. The page shows where each stands and what is next, and tasks-usdt-settle.mjs follows each one to its burn and approves it once
// the pool has minted the USDT again, so nobody has to be found in Discord.
const HELD = {
  '02-tester-second': { address: '0x675628b2e8e9193e668416c04b3dfe1ea6bea088', claim: '0xe4e8d25c641d5df47397d3b6589864a13568db78fe93a2de370f8eefee266bd3' },
  '03-tester-third': { address: '0x4d02d7c510dd360fe05916c5046bb0ecfc0b4377', claim: '0xbdbf5ed262de38b5c7003ef9ee7c96241df30af450321f19279a711ca3603902' },
  '04-tester-fourth': { address: '0x85f2602e95a4490388a7fcdc0f5d83f21b310ad2', claim: '0x9f30faaf9ba73f673cc364218a608f5316b7c0f41ff5703329aeafd028277fd2' },
};

writeJobs(SERVICE_OUT, { id: JOB, chainId: 1, opensAt, steps });
// Closed on 6 November 2026 after the first round trips: the steps are held (`reserved`) for the testers who were in line, each paid once its
// round trip is checked, and the page reads as done (`done`), so nobody else is offered the job.
writeJobs(PAGE_OUT, {
  id: JOB, chainId: 1, opensAt, title: 'Test the USDT bridge', tagline: 'Sending 5 USDT to Bitcoin and back: the first mainnet round trips of USDT, on 6 November.', verified: false, created: [], done: true,
  steps: [
    { ...steps[0], label: 'Tester, first', detail: 'The first round trip, checked on 6 November.', reserved: true, action: ACTION, ask: ASK },
    { ...steps[1], label: 'Tester, second', detail: 'A round trip under way: paid when its USDT is back in the pool.', reserved: true, held: HELD['02-tester-second'], action: ACTION, ask: ASK },
    { ...steps[2], label: 'Tester, third', detail: 'A round trip under way: paid when its USDT is back in the pool.', reserved: true, held: HELD['03-tester-third'], action: ACTION, ask: ASK },
    { ...steps[3], label: 'Tester, fourth', detail: 'A round trip under way: paid when its USDT is back in the pool.', reserved: true, held: HELD['04-tester-fourth'], action: ACTION, ask: ASK },
  ],
  about: [
    { h: 'What it was', p: 'Bridging 5 USDT from a wallet to Bitcoin and back: made private in the Tacit pool, burned there, minted on Bitcoin to the tester\'s own key, burned on Bitcoin and minted in the pool again. The way to Bitcoin and the way back each take a few hours.' },
    { h: 'Paid', p: `${pay} TAC to each of four testers, once their round trip is checked, for the fees (gas, the relay's fee for the way out, about 2,500 sats of Bitcoin) and their time. The first was checked on 6 November, and the others are paid when their USDT is back in the pool. A tester keeps what comes back of the 5 USDT as private USDT.` },
  ],
  links: [{ label: 'The bridge', href: '/bridge/' }, { label: 'Discord', href: 'https://discord.gg/VxYx9XSBrM' }],
});
