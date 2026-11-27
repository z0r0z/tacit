// A move of ETH from the Pay pool into tETH that landed although the relay's answer did not come back (dapp/index.html moveToV1), and the deposits left waiting (autoFinish).
//
// The wallet says its spend may have gone out (`maybeSent`: the relay did not answer, or a spend of the notes is on its way) or that the notes are spent (`spent`). Either can
// be this very move, which then left a deposit in the Tacit pool. moveToV1 asks the pool (depositStatus: 0 none, 1 funded, 2 settled): a funded deposit goes on to its settle with
// no hash to show and its wrap index kept, a settled one is done, and with none the error stands (its wrap index given back unless the spend may have gone out).
// autoFinish presses the Finish of a waiting ETH or token deposit as it does a TAC one, and only the button that belongs to that sheet.
//
// The functions are cut out of dapp/index.html and run against stand-ins for what they touch.
//
// Run: node tests/front-move-landed.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frontPage } from './lib/front-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = frontPage(join(ROOT, 'dapp/index.html'));

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

const between = (from, to) => {
  const a = page.indexOf(from), b = page.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)} .. ${JSON.stringify(to)} in dapp/index.html`);
  return page.slice(a, b);
};
const run = (src, scope, expose) => new Function('scope', `with (scope) { ${src}\nreturn { ${expose} }; }`)(new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t }));

const moveSrc = between('async function moveToV1', 'function deviceSync') + '\n' + between('// The Tacit pool\'s record of a deposit', 'async function hxTacWrapGo');
const finishSrc = between('var AUTO_FIN = new Set();', 'function autoFinishSoon');

const spent = () => Object.assign(new Error('Those funds were already spent. Check Activity.'), { said: true, spent: true });
const unanswered = () => Object.assign(new Error('The relay did not answer, and it may still have sent your payment.'), { said: true, maybeSent: true });
const onItsWay = () => Object.assign(new Error('A spend of these funds is already on its way.'), { said: true, maybeSent: true });
const refused = () => Object.assign(new Error('the relay refused it'), { said: true });

// What the Tacit pool says about the deposit, in turn: `states` (the last repeats).
function mover({ states = [0], toV1 = async () => '0xrelayed' } = {}) {
  const log = { released: [], settled: [], steps: [], asked: 0, waited: 0, kept: [] };
  const clock = { now: 1_000_000 };
  const w = { commit: '0x' + '11'.repeat(32), depositId: '0x' + '22'.repeat(32) };
  const t = {
    cfg: { pool: '0xpool' }, nextWrapIndex: async () => 7, buildWrap: () => w,
    releaseWrapIndex: (a) => log.released.push(a.index), submitWrapSettle: async (a) => { log.settled.push(a.built); },
  };
  const scope = {
    E10: 10n ** 10n, getUx: async () => t, walletPriv: () => 'priv', fmt: (v) => String(v), strip: (x) => String(x).replace(/^0x/, ''),
    payingAccount: async () => '0xa', payFrom: () => ({}), chainNow: () => 1, P: {}, kDep: () => 'dep', keeperTx: (h) => ({ tx: h }),
    walletDeclined: () => false, waitRanOut: () => false, keptDeposit: (e) => Object.assign(new Error('kept'), { cause: e }),
    ethCall: async () => { const s = states[Math.min(log.asked++, states.length - 1)]; return '0x' + s.toString(16).padStart(64, '0'); },
    sleep: async (ms) => { clock.now += ms; log.waited += ms; }, Date: { now: () => clock.now },
  };
  const fns = run(moveSrc, scope, 'moveToV1');
  const W = { toV1, connect() {} };
  const go = (via = null) => fns.moveToV1({ take() {}, check() {}, wait: () => ({}) }, W, 10n ** 14n, (x) => log.steps.push(x), via, null);
  return { go, log, w };
}

console.log('front page: a move that landed goes on to its settle\n');

await test('an answered move is unchanged: it settles and gives the hash', async () => {
  const m = mover();
  const h = await m.go();
  ok(h && h.tx === '0xrelayed', JSON.stringify(h));
  ok(m.log.settled.length === 1 && m.log.released.length === 0 && m.log.asked === 0, 'settles once, nothing looked up, nothing released');
});

await test('notes spent and the deposit funded: it goes on to settle, with no hash and its wrap index kept', async () => {
  const m = mover({ states: [1], toV1: async () => { throw spent(); } });
  const h = await m.go();
  ok(h === null, `hash ${JSON.stringify(h)}`);
  ok(m.log.settled.length === 1 && m.log.settled[0] === m.w, 'settled the deposit of this move');
  ok(m.log.released.length === 0, 'its wrap index was given back');
  ok(m.log.steps.includes('checking whether the move went through') && m.log.steps.includes('the Tacit pool relay is proving your note'), m.log.steps.join(' | '));
});

await test('notes spent and the deposit already settled: the move is done, nothing is settled again', async () => {
  const m = mover({ states: [2], toV1: async () => { throw spent(); } });
  const h = await m.go();
  ok(h === null && m.log.settled.length === 0 && m.log.released.length === 0, `settled ${m.log.settled.length}, released ${m.log.released.length}`);
});

await test('notes spent and no deposit (another spend took them): the error stands, the wrap index is given back, and it waits only a few seconds', async () => {
  const m = mover({ states: [0], toV1: async () => { throw spent(); } });
  await m.go().then(() => ok(false, 'did not throw'), (e) => ok(e.spent === true, e.message));
  ok(m.log.settled.length === 0, 'settled something');
  ok(m.log.released.length === 1 && m.log.released[0] === 7, 'wrap index not given back');
  ok(m.log.waited <= 16_000, `waited ${m.log.waited} ms`);
});

await test('no answer from the relay and the deposit shows up a few seconds later: it goes on to settle', async () => {
  const m = mover({ states: [0, 0, 1], toV1: async () => { throw unanswered(); } });
  const h = await m.go();
  ok(h === null && m.log.settled.length === 1, 'did not settle');
  ok(m.log.asked === 3, `asked the pool ${m.log.asked} times`);
});

await test('a spend of the notes on its way and the deposit funded: it goes on to settle', async () => {
  const m = mover({ states: [1], toV1: async () => { throw onItsWay(); } });
  await m.go();
  ok(m.log.settled.length === 1 && m.log.released.length === 0, 'did not settle');
});

await test('no answer and no deposit within the wait: the error stands, and the wrap index stays taken (the spend may still land)', async () => {
  const m = mover({ states: [0], toV1: async () => { throw unanswered(); } });
  await m.go().then(() => ok(false, 'did not throw'), (e) => ok(e.maybeSent === true, e.message));
  ok(m.log.settled.length === 0 && m.log.released.length === 0, `settled ${m.log.settled.length}, released ${m.log.released.length}`);
  ok(m.log.waited >= 80_000 && m.log.waited <= 100_000, `waited ${m.log.waited} ms`);
});

await test('a refusal with no flag is not looked into: the error stands and the wrap index is given back', async () => {
  const m = mover({ states: [1], toV1: async () => { throw refused(); } });
  await m.go().then(() => ok(false, 'did not throw'), (e) => ok(/refused/.test(e.message), e.message));
  ok(m.log.asked === 0 && m.log.settled.length === 0 && m.log.released.length === 1, `asked ${m.log.asked}, settled ${m.log.settled.length}, released ${m.log.released.length}`);
});

await test('sent from the wallet itself (via self), a flagged error is not looked into', async () => {
  const m = mover({ states: [1], toV1: async () => { throw spent(); } });
  await m.go('self').then(() => ok(false, 'did not throw'), (e) => ok(e.spent === true, e.message));
  ok(m.log.asked === 0 && m.log.settled.length === 0, 'looked into a wallet send');
});

await test('chainHopIn still answers whether a deposit is funded', async () => {
  const log = { asked: 0 }, clock = { now: 0 };
  const w = { depositId: '0x' + '33'.repeat(32) };
  const f = run(between('// The Tacit pool\'s record of a deposit', 'async function hxTacWrapGo'), {
    strip: (x) => String(x).replace(/^0x/, ''), ethCall: async () => '0x' + (log.asked++ >= 1 ? 1 : 0).toString(16).padStart(64, '0'),
    sleep: async (ms) => { clock.now += ms; }, Date: { now: () => clock.now },
  }, 'chainHopIn');
  ok(await f.chainHopIn({ cfg: { pool: '0xp' } }, w, 60e3) === true, 'a funded deposit');
  const g = run(between('// The Tacit pool\'s record of a deposit', 'async function hxTacWrapGo'), {
    strip: (x) => String(x), ethCall: async () => '0x' + '0'.repeat(64), sleep: async (ms) => { clock.now += ms; }, Date: { now: () => clock.now },
  }, 'chainHopIn');
  ok(await g.chainHopIn({ cfg: { pool: '0xp' } }, w, 10e3) === false, 'no deposit');
});

// autoFinish: stand-ins for the page's state and the buttons on it.
function finisher({ pending = {}, visible = {}, hidden = false, busy = null, own = false } = {}) {
  const clicks = [], taken = new Set();
  const button = (id) => ({ offsetParent: {}, disabled: false, getAttribute: () => null, click: () => clicks.push(id) });
  const scope = {
    S: { key: {} }, document: { get hidden() { return hidden; }, querySelectorAll: (sel) => (sel.includes('#tac-finish') ? (visible.tac ? [button('tac')] : []) : sel.includes('#v1-finish') ? (visible.eth ? [button('eth')] : []) : []) },
    busySheet: () => busy, ownOn: () => own, pendingFor: (sheet) => pending[sheet] || [], kDep: (p) => p.id,
  };
  const f = run(finishSrc, scope, 'autoFinish, AUTO_FIN, AUTO_FIN_BY');
  return { ...f, clicks, taken };
}
const dep = (id, ticker = 'cETH') => ({ id, ticker });

await test('a waiting ETH deposit is finished with the Finish that is on screen, once', () => {
  const f = finisher({ pending: { eth: [dep('a')] }, visible: { eth: true } });
  f.autoFinish();
  ok(f.clicks.join() === 'eth', `clicks ${f.clicks}`);
  f.autoFinish();
  ok(f.clicks.length === 1, 'pressed again for the same deposit');
});

await test('a waiting TAC deposit is still finished the same way', () => {
  const f = finisher({ pending: { tac: [dep('t', 'cTAC')] }, visible: { tac: true } });
  f.autoFinish();
  ok(f.clicks.join() === 'tac', `clicks ${f.clicks}`);
});

await test('with no Finish on screen nothing is pressed and the deposit is tried again when one shows', () => {
  const f = finisher({ pending: { eth: [dep('a')] }, visible: {} });
  f.autoFinish();
  ok(f.clicks.length === 0, 'pressed something');
  ok(!f.AUTO_FIN.has('a'), 'marked as tried');
});

await test('nothing is pressed while a sheet is busy, the page is hidden, or the owner proves on their own device', () => {
  for (const o of [{ busy: 'eth' }, { hidden: true }, { own: true }]) {
    const f = finisher({ pending: { eth: [dep('a')] }, visible: { eth: true }, ...o });
    f.autoFinish();
    ok(f.clicks.length === 0, `pressed with ${JSON.stringify(o)}`);
  }
});

await test('a deposit without a ticker is left to the owner', () => {
  const f = finisher({ pending: { eth: [{ id: 'a', ticker: null }] }, visible: { eth: true } });
  f.autoFinish();
  ok(f.clicks.length === 0, 'pressed for an unnamed deposit');
});

await test('the card\'s Finish counts for ETH only when the card is on the ETH sheet', () => {
  const eth = finisher({}).AUTO_FIN_BY.find(([s]) => s === 'eth')[1];
  ok(eth.includes('.hx-fin[data-sheet="eth"] #hx-fin'), eth);
  ok(/el\.dataset\.sheet = sheet;/.test(between('function hxFinishPaint', 'const chainPool')), 'the card\'s callout is not tagged with its sheet');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
