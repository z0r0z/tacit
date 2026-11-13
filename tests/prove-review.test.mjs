// node tests/prove-review.test.mjs -- the code-review card on /prove/: the prover's help desk status and the help desk's stats, turned into what the card shows
import { cleanDesk, cleanStats, reviewView, pressTurnsOn, shortOf, gb, FETCH_CMD, HELPDESK } from '../dapp/prove/review.js';
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
// --- a prover that fetches the model itself (it says `fetching`): one press, and how far it has got
{
  const TOTAL = 2_740_937_888;
  const can = (o = {}) => desk({ installed: false, fetching: false, fetched: 0, fetch_total: TOTAL, fetch_error: null, ...o });
  check('a size is said in GB to one place', gb(TOTAL) === '2.7' && gb(1_150_000_000) === '1.1' && gb(0) === '0.0');
  check('what the prover says of its fetch is read; an older prover says nothing of it', can().canFetch === true && can({ fetching: true, fetched: 5 }).fetching === true && can({ fetched: 5 }).fetched === 5 && can().total === TOTAL && desk({ installed: false }).canFetch === false && desk({ installed: false }).fetching === false);
  check('odd values are read as nothing', (() => { const x = can({ fetching: 'yes', fetched: -1, fetch_total: 'big', fetch_error: 7 }); return x.canFetch === false && x.fetching === false && x.fetched === 0 && x.total === 0 && x.fetchError === null; })());
  const off = reviewView({ proverUp: true, desk: can(), stats: stats(), me: ADDR });
  check('without the model, a prover that can fetch it offers Turn on at once, says what that gets, and shows no line to paste', off.button === 'Turn on' && off.cmd === false && off.state === 'Off · turning it on gets a 2.7 GB model, once' && off.note === '');
  check('with no size known it still reads', reviewView({ proverUp: true, desk: can({ fetch_total: 0 }), stats: stats(), me: ADDR }).state === 'Off · turning it on gets the model, once');
  const going = reviewView({ proverUp: true, desk: can({ on: true, fetching: true, fetched: 1_150_000_000 }), stats: stats(), me: ADDR });
  check('while it fetches, the card says how far it has got, and offers to stop it', going.state === 'Getting the model · 1.1 of 2.7 GB' && going.button === 'Stop' && going.cmd === false);
  check('a fetch can be stopped with no address set too', reviewView({ proverUp: true, desk: can({ on: true, miner: null, fetching: true, fetched: 5 }), stats: stats(), me: null }).button === 'Stop');
  const part = reviewView({ proverUp: true, desk: can({ fetched: 1_150_000_000 }), stats: stats(), me: ADDR });
  check('a fetch that was stopped says what is here already, and turning it on carries on', part.state === 'Off · 1.1 of 2.7 GB of the model is here' && part.button === 'Turn on' && part.cmd === false && part.note === '');
  check('a few bytes here are not worth saying', reviewView({ proverUp: true, desk: can({ fetched: 49_999_999 }), stats: stats(), me: ADDR }).state === 'Off · turning it on gets a 2.7 GB model, once' && reviewView({ proverUp: true, desk: can({ fetched: 50_000_000 }), stats: stats(), me: ADDR }).state === 'Off · 0.1 of 2.7 GB of the model is here');
  check('a press stops a fetch, turns the job on when there is no model yet (whatever it was set to), and with the model switches it', pressTurnsOn(can({ on: true, fetching: true })) === false && pressTurnsOn(can()) === true && pressTurnsOn(can({ on: true })) === true && pressTurnsOn(can({ on: true, fetch_error: 'x' })) === true && pressTurnsOn(desk({ on: true })) === false && pressTurnsOn(desk({ on: false })) === true && pressTurnsOn(desk({ installed: false })) === true);
  check('more than the whole is said as the whole, and no size as plainly getting it', reviewView({ proverUp: true, desk: can({ fetching: true, fetched: TOTAL * 2 }), stats: stats(), me: ADDR }).state === 'Getting the model · 2.7 of 2.7 GB' && reviewView({ proverUp: true, desk: can({ fetching: true, fetch_total: 0 }), stats: stats(), me: ADDR }).state === 'Getting the model…');
  const failed = reviewView({ proverUp: true, desk: can({ on: true, fetch_error: 'needs about 4 GB free in /home/x/.tacit-prover/helpdesk' }), stats: stats(), me: ADDR });
  check('a fetch that stopped says why, in the prover\'s words, offers to try again, and shows the line to paste as another way', failed.state === 'Could not get the model' && failed.button === 'Try again' && failed.cmd === true && failed.note === 'needs about 4 GB free in /home/x/.tacit-prover/helpdesk');
  const dirty = cleanDesk({ on: true, installed: false, fetching: false, fetch_error: 'bad\u001b[2J <b>x</b>\n' + 'y'.repeat(400) }).fetchError;
  check('the prover\'s words are kept to plain text of a line\'s length', !/[\u0000-\u001f\u007f-\uffff]/.test(dirty) && dirty.length === 160 && dirty.startsWith('bad [2J <b>x</b> y'));
  check('an empty error is none', can({ fetch_error: '   ' }).fetchError === null);
  check('with no address to pay, it is not offered', (() => { const v = reviewView({ proverUp: true, desk: can({ miner: null }), stats: stats(), me: null }); return v.button === null && v.state === 'Start proving with your address first'; })());
  check('once the files are here it is the card as before', reviewView({ proverUp: true, desk: can({ installed: true, on: true }), stats: stats(), me: ADDR }).state === 'On · when this computer is idle and plugged in' && reviewView({ proverUp: true, desk: can({ installed: true }), stats: stats(), me: ADDR }).button === 'Turn on');
  check('every view carries a note, empty when nothing went wrong', [reviewView({ proverUp: false, desk: null, stats: null, me: null }), reviewView({ proverUp: true, desk: null, stats: null, me: null }), reviewView({ proverUp: true, desk: desk({ installed: false }), stats: null, me: null }), reviewView({ proverUp: true, desk: desk({ on: true }), stats: null, me: null })].every((v) => v.note === ''));
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
