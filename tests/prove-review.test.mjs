// node tests/prove-review.test.mjs -- the code-review card on /prove/: the prover's help desk status and the help desk's stats, turned into what the card shows
import { cleanDesk, cleanStats, reviewView, shortOf, FETCH_CMD, HELPDESK } from '../dapp/prove/review.js';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };

const ADDR = '0x66f5A1225e6ac772c461f2b4d8028bf9568f3db5', SHORT = '0x66f5a1…3db5';
const desk = (o = {}) => cleanDesk({ on: false, api: HELPDESK, miner: ADDR, installed: true, model_running: false, served: 0, job: null, idle_secs_needed: 300, ...o });
const stats = (reviewers = [], online = 3) => cleanStats({ nodes: { online }, swarm: { reviewers } });

check('an address is shortened the way the help desk lists it', shortOf(ADDR) === SHORT && shortOf('0x123') === null && shortOf(null) === null);
check('the fetch line pipes the script to bash (it is a bash script), from tacit.finance', FETCH_CMD === 'curl -fsSL https://tacit.finance/helpdesk-fetch.sh | bash' && HELPDESK === 'https://tacit-helpdesk.onrender.com');

// --- reading the prover
check('a prover without the help desk route answers nothing usable', cleanDesk(null) === null && cleanDesk({ error: 'not found' }) === null && cleanDesk('x') === null);
{
  const d = desk({ on: true, model_running: true, served: '12', job: { id: 'a', secs: 3 } });
  check('the prover\'s answer is read: on, installed, running, busy, answers, its address (lower case)', d.on && d.installed && d.running && d.busy && d.served === 12 && d.miner === ADDR.toLowerCase());
  check('odd values are read as nothing', (() => { const x = cleanDesk({ on: true, installed: 'yes', model_running: 1, served: -4, miner: 'evil', job: 'x' }); return x.installed === false && x.running === false && x.served === 0 && x.miner === null && x.busy === false; })());
}
// --- reading the help desk
{
  const s = cleanStats({ nodes: { online: 4 }, swarm: { reviewers: [{ miner: SHORT, skeptic: { n: 37, right: 22 }, scout: { n: 17, found: 5 } }, null, { miner: 5 }, { miner: '0xABCDEF…1234', skeptic: { n: 'x' } }] } });
  check('the stats give the nodes online and each review record, odd rows dropped and odd numbers zero', s.online === 4 && s.reviewers.length === 2 && s.reviewers[0].checks === 37 && s.reviewers[0].right === 22 && s.reviewers[0].found === 5 && s.reviewers[1].miner === '0xabcdef…1234' && s.reviewers[1].checks === 0);
  check('stats from before the review swarm, or none, are read as no records', cleanStats({ nodes: { online: 1 } }).reviewers.length === 0 && cleanStats(null) === null);
}

// --- what the card shows
{
  const v = reviewView({ proverUp: false, desk: null, stats: stats(), me: ADDR });
  check('with no prover the card says so, with no button and no fetch line', v.state === 'Needs tacit-prover, above' && v.button === null && !v.cmd && v.online === '3');
  const old = reviewView({ proverUp: true, desk: null, stats: null, me: ADDR });
  check('a prover too old for the help desk is asked to update', old.state === 'Update tacit-prover to turn this on' && old.button === null && old.online === '—');
  const fetch = reviewView({ proverUp: true, desk: desk({ installed: false }), stats: stats(), me: ADDR });
  check('without the model the card shows the line that gets it, and no button yet', fetch.cmd === true && fetch.button === null && fetch.state === 'Get the model first');
  const off = reviewView({ proverUp: true, desk: desk(), stats: stats(), me: ADDR });
  check('installed and off: Turn on', off.state === 'Off' && off.button === 'Turn on' && !off.cmd);
  const noAddr = reviewView({ proverUp: true, desk: desk({ miner: null }), stats: stats(), me: null });
  check('a prover with no address to pay cannot turn it on: the points would have nowhere to go', noAddr.button === null && noAddr.state === 'Start proving with your address first');
  const waiting = reviewView({ proverUp: true, desk: desk({ on: true }), stats: stats(), me: ADDR });
  check('on and waiting: it says when it works, and Turn off', waiting.state === 'On · when this computer is idle and plugged in' && waiting.button === 'Turn off');
  check('on with the model up: Ready, and the answers so far', reviewView({ proverUp: true, desk: desk({ on: true, model_running: true, served: 7 }), stats: stats(), me: ADDR }).state === 'Ready · 7 answered');
  check('on with a job under way: Reviewing', reviewView({ proverUp: true, desk: desk({ on: true, model_running: true, job: { id: 'j' }, served: 8 }), stats: stats(), me: ADDR }).state === 'Reviewing · 8 answered');
}
// --- the record
{
  const rec = [{ miner: SHORT, skeptic: { n: 37, right: 22 }, scout: { n: 17, found: 5 } }];
  check('the record of the prover\'s address is shown', reviewView({ proverUp: true, desk: desk(), stats: stats(rec), me: null }).record === '22 of 37 checks right · 5 of 17 planted bugs found');
  check('with no prover, the address in the field is looked up', reviewView({ proverUp: false, desk: null, stats: stats(rec), me: ADDR }).record === '22 of 37 checks right · 5 of 17 planted bugs found');
  check('only checks, or only scouting, shows only that', reviewView({ proverUp: false, desk: null, stats: stats([{ miner: SHORT, skeptic: { n: 4, right: 3 } }]), me: ADDR }).record === '3 of 4 checks right' && reviewView({ proverUp: false, desk: null, stats: stats([{ miner: SHORT, scout: { n: 2, found: 0 } }]), me: ADDR }).record === '0 of 2 planted bugs found');
  check('an address with no record, or nothing graded yet, shows none', reviewView({ proverUp: true, desk: desk(), stats: stats([]), me: ADDR }).record === null && reviewView({ proverUp: true, desk: desk(), stats: stats([{ miner: SHORT, skeptic: { n: 0 } }]), me: ADDR }).record === null && reviewView({ proverUp: false, desk: null, stats: stats(rec), me: null }).record === null);
  check('another address\'s record is not shown as yours', reviewView({ proverUp: false, desk: null, stats: stats(rec), me: '0x' + '1'.repeat(40) }).record === null);
}
console.log(fails ? `${fails} prove review test(s) failed` : 'prove review: all tests passed'); process.exit(fails ? 1 : 0);
