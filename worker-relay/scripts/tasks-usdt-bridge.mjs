// Builds the task job that proves the USDT bridge on mainnet with a small round trip, merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//
//   node worker-relay/scripts/tasks-usdt-bridge.mjs [--opens <unix secs>] [--tac <TAC a step pays>] [--tester <tx hash>] [--tester2 <tx hash>] [--tester3 <tx hash>]
//
// A tester takes about 5 USDT (a small amount is the point and a larger one pays no more; the relay's fee follows gas, about 3 USDT at 1.7 gwei on 6 November 2026, so less than that
// cannot cross and 5 leaves about 2 on Bitcoin) from its wallet to Bitcoin and back: made private in the pool, burned there, minted on Bitcoin by its own key, burned on
// Bitcoin and minted in the pool again. Nothing on Ethereum is sent by the work's owner, so no transaction names who did it: the tester sends itself a transaction naming
// the Bitcoin transaction that brought the USDT back (its burn), which the page does, and the step lists that hash after review (a push and a deploy of the points
// service). The review checks the burn on Bitcoin (a bridge burn of the USDT id, spending a note a cross-out minted for the tester's key) and the mint it paid on Ethereum.
// Each step pays once, as the fast bridge job's did, a fixed sum. 250 TAC (TAC at $0.13, ETH at $2,400 and Bitcoin at $80,000 on 6 November 2026): about $6 of fees (Ethereum gas for
// the approval and the deposit, about $1; the relay's fee for the way out, about 3 USDT, the way back being free; about 2,500 sats of Bitcoin for the two Bitcoin steps, about $2), about 50 TAC, and the rest
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
const steps = [step('01-tester', 'tester'), step('02-tester-second', 'tester2'), step('03-tester-third', 'tester3')];
const ASK = 'The Bitcoin transaction that brought your USDT back (its burn). It is paid to the wallet you claim from.';
const ACTION = { label: 'Bridge 5 USDT', href: '/#card=bridge:wusdt&amt=5' };

writeJobs(SERVICE_OUT, { id: JOB, chainId: 1, opensAt, steps });
writeJobs(PAGE_OUT, {
  id: JOB, chainId: 1, opensAt, title: 'Test the USDT bridge', tagline: 'Send 5 USDT to Bitcoin and back: the first mainnet round trips of USDT. A small amount is all it takes.', verified: false, created: [],
  hint: 'Opens the bridge with 5 USDT in it: that is enough, and more pays no more. The way to Bitcoin and the way back each take hours: come back here to claim when the USDT is back in the pool.',
  steps: [
    { ...steps[0], label: 'Tester, first', detail: '5 USDT to Bitcoin and back.', action: ACTION, ask: ASK },
    { ...steps[1], label: 'Tester, second', detail: 'A second, independent round trip.', action: ACTION, ask: ASK },
    { ...steps[2], label: 'Tester, third', detail: 'A third, independent round trip.', action: ACTION, ask: ASK },
  ],
  about: [
    { h: 'What to do', p: 'Bridge 5 USDT from your wallet to Bitcoin and back, on the bridge page or the front page\'s Bridge tab. This is new and unproven on mainnet, so use a small amount: 5 is enough, a larger bridge pays no more, and one bridge takes 100 at most. The relay\'s fee for the way to Bitcoin follows gas (about 3 USDT at today\'s, and the form says it before you press), so 5 USDT arrives on Bitcoin as about 2; less than the fee cannot cross. The USDT is made private in the Tacit pool first (one approval of exactly the amount and one signature), burned there, and minted on Bitcoin to your own key a few hours later. The two Bitcoin steps are paid from your own Bitcoin address, about 2,500 sats in all, so have that on it. Bring it back from Bitcoin (a burn there, then a mint in the pool, free of any fee, about four hours and then the next proof). What comes back is private USDT in the pool: withdrawing it to your wallet costs the relay\'s fee again (about 2.5 USDT today), so leave it there unless gas is low or you bridged more.' },
    { h: 'What is checked', p: 'Claim with the Bitcoin transaction that brought your USDT back. It is read by hand: that it burns a note of the USDT asset that a cross-out minted for your key, that the pool minted it again as private USDT. If anything goes wrong on the way, that is the finding: say what happened in Discord, with the transaction ids, and it is paid for as well.' },
    { h: 'Paid', p: `${pay} TAC to each of the first three testers whose round trip is checked. About $6 of it is the fees (gas for the approval and the deposit, the relay's fee of about 3 USDT for the way out, and about 2,500 sats of Bitcoin), and the rest pays for your time. You keep what comes back of your USDT, about 2 of the 5, as private USDT.` },
  ],
  links: [{ label: 'The bridge', href: '/bridge/' }, { label: 'Discord', href: 'https://discord.gg/VxYx9XSBrM' }],
});
