// The front page's zap flows (dapp/index.html), the parts that decide what is kept, finished or said when a step stops. The real source is cut out of the page and run with
// stand-ins for the wallet, the chain and the relay (the technique of tests/op-sync-done.test.mjs):
//   keepPaidProof     a proof made with the person's own credit is kept as a ready voucher when the zap was not sent with it
//   the start record  a pool started in two steps keeps a record from before its first step, and xtStartResume finishes it where it stopped (the shares are the payer's
//                     public liquidity until the second step): made private if they still are, dropped if the add never landed, settled if they already are
//   zapWay            the relay choice is only offered where the zap can be sent first (xtShareProof's proof travels in the zap's own transaction)
//   poolRows          a token's reserve in the pool's units of it (a 6-decimal token's unit is 1e-6, not 1e-8)
//   xtShareProof      its share's index goes back when no proof comes of it
//   and the source of the voucher branch, the recovered zap, the sends that report themselves sent, the guard held after the proof
//   node --test tests/zap-page-flows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeVouchers } from '../dapp/wrap-vouchers.js';
import { frontPage } from './lib/front-page.mjs';

const html = frontPage(new URL('../dapp/index.html', import.meta.url));
const cut = (a, b) => { const s = html.indexOf(a), e = html.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the page has ${a}`); return html.slice(s, e); };
const make = (src, names, stubs, returns) => new Function(...names, `${src}\nreturn { ${returns} };`)(...names.map((k) => stubs[k]));
const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
const lc = (s) => String(s || '').toLowerCase();

// ── a proof paid for is kept ──
const POOL = '0x' + 'aa'.repeat(32), PUB = '02' + 'ab'.repeat(32);
const built = { amount: 123n, index: 7, commit: '0x' + 'cc'.repeat(32), depositId: '0x' + 'dd'.repeat(32), leaf: '0x' + 'ee'.repeat(32), memos: ['0x01'], wrapArgs: { assetId: '0x' + 'a1'.repeat(32) } };
function paid({ fits = true, sentRecs = [] } = {}) {
  const store = makeVouchers({ storage: memoryStorage() });
  const src = `${cut('const lpRec = ', '\nasync function lpSharesFor')}\n${cut('async function keepPaidProof(', '\nconst ZAPWAY')}`;
  const { keepPaidProof } = make(src, ['lpTicker', 'S', 'vouchers', 'zapsKept'], { lpTicker: () => 'cETH/TAC', S: { key: { pubHex: PUB } }, vouchers: async () => store, zapsKept: () => sentRecs }, 'keepPaidProof');
  const t = { wrapProofFits: () => fits };
  return { store, keep: (proven = { publicValues: '0xpv', proof: '0xpf', memos: ['0x02'] }) => keepPaidProof(POOL, { built, index: 7, proven }, t) };
}
test('a proof made with the own credit is kept as a ready voucher the next press finds', async () => {
  const w = paid();
  assert.equal(await w.keep(), true);
  const [v] = w.store.list(PUB, 'cETH/TAC', 'ready');
  assert.ok(v, 'it is a ready voucher for the pool’s ticker');
  assert.deepEqual([v.amount, v.index, v.depositId, v.commit, v.leaf, v.publicValues, v.proof, v.memos, v.by, v.poolId], ['123', 7, built.depositId, built.commit, built.leaf, '0xpv', '0xpf', ['0x02'], 'own', POOL]);
  assert.equal(w.store.call(v).proven.publicValues, '0xpv', 'and the proof it carries is the one made');
});
test('a proof the zap was sent with, or one that is not for this share, is not kept', async () => {
  const sent = paid({ sentRecs: [{ depositId: built.depositId, tx: '0x1' }] });
  assert.equal(await sent.keep(), false); assert.equal(sent.store.list(PUB).length, 0, 'a zap sent with it has spent it');
  const wrong = paid({ fits: false });
  assert.equal(await wrong.keep(), false); assert.equal(wrong.store.list(PUB).length, 0);
  const noKey = make(`${cut('const lpRec = ', '\nasync function lpSharesFor')}\n${cut('async function keepPaidProof(', '\nconst ZAPWAY')}`, ['lpTicker', 'S', 'vouchers', 'zapsKept'], { lpTicker: () => 'x', S: { key: null }, vouchers: async () => { throw new Error('no'); }, zapsKept: () => [] }, 'keepPaidProof');
  assert.equal(await noKey.keepPaidProof(POOL, { built, proven: {} }, { wrapProofFits: () => true }), false, 'with no key open it keeps nothing, and does not throw');
});
test('zapNow keeps the paid proof on a stop before the send, and does not give its index back', () => {
  const now = cut('async function zapNow(', '\nasync function zapShareFirst');
  assert.match(now, /catch \(e\) \{ keptProof = await keepPaidProof\(p\.poolId, c, t\); throw e; \}/, 'the credit branch keeps it');
  assert.match(now, /if \(built && !hash && t && !keptProof && \(payer\(\) === 'tacit' \|\| walletDeclined\(e\)\)\) t\.releaseShareIndex/, 'a kept proof keeps its index');
});

// ── the voucher at the press, and a zap already sent with it ──
test('the press takes a voucher only as the quote did, and never one a zap is already sent with', () => {
  const now = cut('async function zapNow(', '\nasync function zapShareFirst');
  assert.match(now, /const roomFor = \(r\) => z\.have == null \|\| r\.plan\.value \+ ZAP_SETTLE_GAS \* gp \* 3n \/ 2n <= z\.have;/);
  assert.match(now, /else if \(ready && zapsKept\(\)\.some\(\(k\) => k\.depositId === ready\.x\.depositId\)\) throw/, 'a zap sent with this proof that has not landed is not sent twice');
  assert.match(now, /else if \(ready && \(z\.ready \|\| roomFor\(ready\)\)\) \{/, 'a voucher the quote left out for the balance is left out at the press');
});
test('a zap found on the chain is not farmed unasked', () => {
  assert.match(cut('function zapsRead()', '\nasync function zapsFinish'), /depositId: f\.depositId, tx: f\.tx, at: Date\.now\(\), bond: false \}\)/);
});

// ── the relay choice ──
test('the relay choice is offered only where the zap can be sent first', () => {
  const src = cut('function zapWay(', "\ndocument.addEventListener('click'");
  const html_ = (s, ...v) => s.reduce((a, x, i) => a + x + (v[i] ?? ''), '');
  const told = [];
  const { zapWay } = make(src, ['ZAPWAY', 'html', 'VOUCH'], { ZAPWAY: { cb: null, then: null, id: 0 }, html: html_, VOUCH: {} }, 'zapWay');
  zapWay({ tell: (m) => told.push(m) }); zapWay({ tell: (m) => told.push(m), relay: false });
  assert.match(told[0], /data-zapway="own"/); assert.match(told[0], /data-zapway="relay"/, 'the farm zap offers the relay to finish it');
  assert.match(told[1], /data-zapway="own"/); assert.doesNotMatch(told[1], /data-zapway="relay"/); assert.match(told[1], /keep waiting/, 'the SPX zaps offer to wait');
  assert.match(cut('async function xtShareProofSteps(', '\nasync function xtZapSend'), /down: false, relay: false \}\)/, 'and xtShareProof asks it that way');
});

// ── a pool's reserves, in the units the pool holds them ──
test('a token’s reserve is in the pool’s units of it', () => {
  const src = cut('function poolRows(', '\n// How long a farm');
  const { poolRows } = make(src, ['assetById', 'poolWorth', 'hxUsd', 'sig'], { assetById: (id) => ({ [CETH]: { ticker: 'tETH' }, [TOK]: { ticker: 'USDX' } })[lc(id)], poolWorth: () => 0, hxUsd: () => '', sig: (n) => String(n) }, 'poolRows');
  const CETH = '0x' + '11'.repeat(32), TOK = '0x' + '22'.repeat(32);
  const pool = { pair: 'USDX/cETH', reserves: { assetA: CETH, assetB: TOK, reserveA: 300_000_000n, reserveB: 5_000_000n } };
  assert.match(poolRows(pool, null, { id: TOK, dec: 6, scale: 1n })[0][1], /^3 tETH · 5 USDX/, 'a 6-decimal token of scale 1: 5,000,000 units are 5 of it');
  assert.match(poolRows(pool)[0][1], /^3 tETH · 0\.05 USDX/, 'read as 1e-8 (the old way) it was a hundredth');
  const e18 = { pair: 'TOK/cETH', reserves: { assetA: CETH, assetB: TOK, reserveA: 300_000_000n, reserveB: 500_000_000n } };
  assert.match(poolRows(e18, null, { id: TOK, dec: 18, scale: 10n ** 10n })[0][1], /^3 tETH · 5 USDX/, 'an 18-decimal token with a unit of 1e10 is 1e-8 of one, as before');
  const own = html.match(/rc\.unshift\(\.\.\.poolRows\(spxFarmOf\(r\) \|\| r\.pool\?\.res && \{ pair: `\$\{r\.sym\}\/cETH`, reserves: r\.pool\.res \}, null, r\)\);/);
  assert.ok(own, 'the row read for a pool the page holds takes the reserves it keeps (res), which the pool object has');
});

// ── an index given back ──
test('xtShareProof gives its share’s index back when no proof comes of it', async () => {
  const released = [];
  const { xtShareProof } = make(cut('async function xtShareProof(args) {', '\nasync function xtShareProofSteps'), ['xtShareProofSteps'], { xtShareProofSteps: async (a, made) => { made.index = 9; if (a.fail) throw new Error('prove failed'); return { built: 1 }; } }, 'xtShareProof');
  const t = { releaseShareIndex: (x) => released.push(x) }, args = { t, priv: 'P', poolId: POOL };
  assert.deepEqual(await xtShareProof({ ...args }), { built: 1 }); assert.equal(released.length, 0, 'a proof that came keeps its index');
  await assert.rejects(xtShareProof({ ...args, fail: true }), /prove failed/);
  assert.deepEqual(released, [{ walletPriv: 'P', poolId: POOL, index: 9 }]);
});
test('the SPX zaps give their index back when nothing was sent with the proof, and the add is checked again at the pool after it', () => {
  const add = cut('async function xtAddCore(', '\n// The standalone farm that takes'), start = cut('async function xtStartCore(', '\n// A tETH pool started from BOTH sides');
  assert.match(add, /let sent = false, hash;[\s\S]*sent: \(\) => \{ sent = true; \}[\s\S]*catch \(e\) \{ if \(!sent\) \{ try \{ t\.releaseShareIndex/);
  assert.match(add, /const bad = await xtAddCheck\(r, \{ ra, rb, plan: now \}\); if \(bad\) throw xtSaid\(`\$\{bad\} Nothing was sent\.`\);/);
  assert.match(start, /let sent = false, hash;[\s\S]*sent: \(\) => \{ sent = true; \}[\s\S]*catch \(e\) \{ if \(!sent\) \{ try \{ t\.releaseShareIndex/);
  const send = cut('async function xtZapSend(', '\nasync function xtStartCore');
  assert.equal((send.match(/\n\s+sent\(\);/g) || []).length, 2, 'both sends (the batch and the single transaction) say they went');
});

// ── a pool start that stopped between its two steps ──
const OWNER = '0x' + '0a'.repeat(20), SHIELD = '0xshield';
function start({ state = 0n, sim = 'ok', owner = OWNER, sendErr = null, readErr = null, rec = null } = {}) {
  const storage = memoryStorage(), log = [];
  const recs = `${cut('const STARTS_KEY', '\nasync function xtStartResume(')}`;
  const names = ['localStorage', 'S', 'errText', 'your', 'getUx', 'walletPriv', 'payer', 'rpc', 'wordAt', 'strip', 'ADDR', 'kDep', 'usdtOwner', 'short', 'xtSaid', 'simWhy', 'runTx', 'sendTx', 'waitTx', 'xtStartSettle', 'xtSave', 'POOL_START_FEE'];
  const r = { addr: '0xTOKEN', sym: 'SPX' }, poolId = POOL;
  const t = { buildShareWrap: ({ shares, index }) => { log.push(['build', shares, index]); return { depositId: '0x' + 'dd'.repeat(32), commit: '0x' + 'cc'.repeat(32) }; }, router: { shieldSharesCalldata: () => SHIELD }, cfg: { pool: '0xPOOL' }, lpShareId: () => 'lp' };
  const stubs = { localStorage: storage, S: { key: { pubHex: PUB } }, errText: (e) => e?.message || '', your: () => 'your wallet', getUx: async () => t, walletPriv: () => 'P', payer: () => 'wallet',
    rpc: async (m, [c]) => {
      if (c.data?.startsWith('0x7da9874f')) { if (readErr) throw readErr; return '0x' + state.toString(16).padStart(64, '0'); }
      log.push(['call', c.from]); if (sim === 'revert') throw Object.assign(new Error('reverted'), { revert: true }); if (sim === 'down') throw new Error('Ethereum is unreachable'); return '0x';
    },
    wordAt: (h) => BigInt(h || '0x0'), strip: (h) => String(h).replace(/^0x/, ''), ADDR: { pool: '0xPOOL' }, kDep: () => 'dep', usdtOwner: () => owner, short: (a) => String(a).slice(0, 8),
    xtSaid: (m) => Object.assign(new Error(m), { said: true }), simWhy: (e) => (e?.revert ? 'refused' : 'could not be checked'), runTx: (run, h) => h,
    sendTx: async (x) => { log.push(['send', x.to, x.data, x.via]); if (sendErr) throw sendErr; return '0xhash'; }, waitTx: async (h) => { log.push(['wait', h]); },
    xtStartSettle: async (x) => { log.push(['settle', x.hash]); }, xtSave: () => {}, POOL_START_FEE: 30 };
  const api = make(`${recs}\n${cut('async function xtStartResume(', '\n// The same pool started from PRIVATE')}`, names, stubs, 'startKeep, startDone, startPending, startsKept, xtStartResume, xtStillPublic');
  const record = { pub: PUB, poolId, addr: '0xtoken', shares: '5000', index: 4, owner: OWNER, at: 1, ...(rec || {}) };
  api.startKeep(record);
  const run = { say() {}, take() {} };
  return { api, log, r, record, resume: () => api.xtStartResume({ run, r, st: null, rec: record }) };
}
test('a start is kept per key and token, found whatever the token address’s case, and dropped when done', () => {
  const w = start();
  assert.equal(w.api.startPending(w.r)?.index, 4, 'found by the key and the token’s address');
  assert.equal(w.api.startPending({ addr: '0xOTHER' }), null);
  w.api.startKeep({ ...w.record, shares: '6000' }); assert.equal(w.api.startsKept().length, 1, 'the same pool kept again replaces its record');
  w.api.startKeep({ ...w.record, poolId: '0x' + 'bb'.repeat(32), addr: '0xother' }); assert.equal(w.api.startsKept().length, 2);
  w.api.startDone(PUB, POOL); assert.equal(w.api.startPending(w.r), null); assert.equal(w.api.startsKept().length, 1);
  assert.equal(start().api.startKeep({ pub: PUB }) ?? null, null); // a record without what a resume needs is not kept: nothing to throw about
});
test('shares still public are made private from the account that holds them, then settled, and the record goes', async () => {
  const w = start({ state: 0n }), out = await w.resume();
  assert.deepEqual(out, { hash: '0xhash' });
  assert.deepEqual(w.log.map((x) => x[0]), ['build', 'call', 'send', 'wait', 'settle']);
  assert.deepEqual(w.log[1], ['call', OWNER], 'the call is run from the account that holds the shares');
  assert.deepEqual(w.log[2], ['send', '0xPOOL', SHIELD, 'wallet'], 'to the pool, the payer’s own shieldShares');
  assert.equal(w.log[4][1], '0xhash', 'the share is settled as in a start that did not stop');
  assert.equal(w.api.startPending(w.r), null);
});
test('a start whose add never landed has nothing to finish: the record is dropped and the start is made as new', async () => {
  const w = start({ state: 0n, sim: 'revert' });
  assert.equal(await w.resume(), null); assert.equal(w.api.startPending(w.r), null);
  assert.ok(!w.log.some((x) => x[0] === 'send'), 'nothing is sent');
});
test('shares already shielded are settled, not shielded twice; ones already private are done', async () => {
  const waiting = start({ state: 1n }), a = await waiting.resume();
  assert.deepEqual(a, { hash: null }); assert.deepEqual(waiting.log.map((x) => x[0]), ['build', 'settle']); assert.equal(waiting.api.startPending(waiting.r), null);
  const done = start({ state: 2n }), b = await done.resume();
  assert.deepEqual(b, { hash: null }); assert.deepEqual(done.log.map((x) => x[0]), ['build']); assert.equal(done.api.startPending(done.r), null);
  assert.equal(done.r.pooled, true, 'and the token is known as pooled');
});
test('what could not be told is not guessed: the record stays', async () => {
  const net = start({ readErr: new Error('Ethereum is unreachable') });
  await assert.rejects(net.resume(), /unreachable/); assert.ok(net.api.startPending(net.r), 'a deposit that could not be read keeps its record');
  const down = start({ sim: 'down' });
  await assert.rejects(down.resume(), (e) => e.said && /could not be checked/.test(e.message)); assert.ok(down.api.startPending(down.r), 'a call that could not be run keeps it');
  const other = start({ owner: '0x' + '0b'.repeat(20) });
  await assert.rejects(other.resume(), (e) => e.said && /Switch to that account/.test(e.message)); assert.ok(other.api.startPending(other.r), 'shares held by another account are not given up on');
  assert.ok(!other.log.some((x) => x[0] === 'call' || x[0] === 'send'));
});
test('a no in the wallet says the shares are still public and keeps the record', async () => {
  const w = start({ state: 0n, sendErr: Object.assign(new Error('Cancelled in your wallet.'), { code: 4001 }) });
  await assert.rejects(w.resume(), (e) => e.said && /still public liquidity/.test(e.message) && /Press Start the pool again/.test(e.message) && /Cancelled in your wallet\./.test(e.message));
  assert.ok(w.api.startPending(w.r)); assert.ok(!w.log.some((x) => x[0] === 'settle'));
});
test('the start card keeps a stopped start’s row, says what its press does, and the press finishes it first', () => {
  assert.match(html, /const xtEarnRows = \(\) => .*const stopped = !!startPending\(r\); return \{ k: `\$\{r\.pool && !stopped \? 'xa' : 'xs'\}:\$\{r\.addr\}`/);
  assert.match(html, /if \(start && startPending\(r\)\) return \{ out: null, go: 'Make your share private', warn: false,/);
  const go = cut('async function xtEarnGo(', '\n// A token pool as the farm code');
  assert.match(go, /pend = start \? startPending\(r\) : null;[\s\S]*const resumed = pend \? await xtStartResume\(\{ run, r, st, rec: pend \}\) : null;\s+if \(resumed\) hash = resumed\.hash;\s+else if \(HX\.from === 'eth'\)/);
  assert.match(go, /\$\{hash \? txLink\(hash\) : ''\}/, 'a resumed start that needed no transaction has no link to show');
});
test('the start in two steps keeps its record before the add, and gives nothing back once the add is sent; the batch with a token to add is not run as a call first', () => {
  const both = cut('async function xtStartBoth(', '\n// The share of a started pool');
  assert.match(both, /startKeep\(\{ pub, poolId, addr: String\(r\.addr\)\.toLowerCase\(\), shares: String\(plan\.shares\), index, owner: plan\.owner, at: Date\.now\(\) \}\);[\s\S]*?const added = runTx\(run, await sendTx\(/, 'the record comes before the add is sent');
  assert.match(both, /addSent = true;\s+await waitTx\(added\);/);
  assert.match(both, /catch \(e\) \{ throw xtStillPublic\(r, e\); \}\s+await waitTx\(hash\);\s+startDone\(pub, poolId\);/, 'a second step that is not sent says the shares are public, and the record goes once it has landed');
  assert.match(both, /addSent = true;\s+await waitTx\(added\);\s+addLanded = true;/, 'the add is known to have landed once its wait is over');
  assert.match(both, /if \(!addLanded && \(!addSent \|\| e\?\.dropped \|\| \/reverted\/i\.test\(e\?\.message \|\| ''\)\)\) \{ startDone\(pub, poolId\); try \{ t\.releaseShareIndex/, 'only an add that never went in lets its index and record go: a shield that was replaced or dropped does not');
  assert.match(both, /if \(!\(batch && r\.registered !== true\)\) \{\s+try \{ await rpc\('eth_call', \[\{ from: plan\.owner, to: router, data,/, 'a batch that adds the token first is not simulated before the token is in');
  assert.match(both, /simWhy\(e, 'the pool', 'start as it stands', 'No pool was started'\)/);
});

// ── xtStartBoth itself, replayed ──
// The start from ETH and the token the wallet holds, over stand-ins for the wallet, the chain and the relay: what is kept, given back and sent at each stop.
function both({ batch = false, registered = true, sendErrAt = null, waitErr = {}, sim = 'ok' } = {}) {
  const storage = memoryStorage(), log = [];
  const recs = cut('const STARTS_KEY', '\nasync function xtStartResume(');
  const src = `${recs}\n${cut('async function xtStartBoth(', '\n// The share of a started pool')}`;
  const names = ['localStorage', 'S', 'errText', 'your', 'getUx', 'walletPriv', 'payer', 'canBatch', 'xtRegister', 'permit2Args', 'xtToken', 'rpc', 'chainNow', 'scanOwned', 'zapsKept', 'vouchers', 'lpTicker', 'kDep', 'sendBatch', 'sendTx', 'waitTx', 'runTx', 'txLink', 'html',
    'xtFrom', 'xtSaid', 'simWhy', 'xtStartSettle', 'xtSave', 'POOL_START_FEE', 'wordAt', 'strip', 'usdtOwner'];
  const r = { addr: '0xTOKEN', sym: 'SPX', id: '0xid', registered };
  const t = { assetByTicker: { cETH: { assetId: '0xETH' } }, cfg: { router: '0xROUTER', pool: '0xPOOL' }, externalAsset: async () => ({ registered, row: {} }), addAsset() {}, poolReserves: async () => null, routePoolId: () => POOL,
    registerTokenCall: () => ({ to: '0xPOOL', data: '0xreg' }), nextShareIndex: () => 5, buildShareWrap: ({ index }) => ({ index, commit: '0xcommit' }), releaseShareIndex: (x) => log.push(['release', x.index]), lpShareId: () => 'lp',
    router: { addLiquidityPublicETHWithPermit2Calldata: () => '0xadd', shieldSharesCalldata: () => '0xshield' } };
  let sends = 0;
  const stubs = { localStorage: storage, S: { key: { pubHex: PUB } }, errText: (e) => e?.message || '', your: () => 'your wallet', getUx: async () => t, walletPriv: () => 'P', payer: () => (batch ? 'wallet' : 'tacit'), canBatch: async () => batch,
    xtRegister: async () => { log.push(['register']); }, permit2Args: async () => ({ permit2: { permitSingle: {}, signature: '0xs' } }), xtToken: () => ({}),
    rpc: async (m, [c]) => { log.push(['call', c.to]); if (sim === 'revert') throw Object.assign(new Error('reverted'), { revert: true }); return '0x'; }, chainNow: () => 1_800_000_000, scanOwned: async () => [], zapsKept: () => [], vouchers: async () => ({ list: () => [] }), lpTicker: () => 'x', kDep: () => 'dep',
    sendBatch: async (calls) => { log.push(['batch', calls.length]); return '0xbatch'; },
    sendTx: async (x) => { sends++; log.push(['send', x.data]); if (sendErrAt === sends) throw Object.assign(new Error('Cancelled in your wallet.'), { code: 4001 }); return '0xtx' + sends; },
    waitTx: async (h) => { log.push(['wait', h]); if (waitErr[h]) throw waitErr[h]; return {}; }, runTx: (run, h) => h, txLink: (h) => h, html: (s, ...v) => s.reduce((a, x, i) => a + x + (v[i] ?? ''), ''),
    xtFrom() {}, xtSaid: (m) => Object.assign(new Error(m), { said: true }), simWhy: (e, who, what, lead) => `${lead || 'Nothing was sent'}: ${e?.revert ? 'refused' : 'unchecked'}`,
    xtStartSettle: async (x) => { log.push(['settle', x.hash]); }, xtSave() {}, POOL_START_FEE: 30, wordAt: (h) => BigInt(h || '0x0'), strip: (h) => String(h).replace(/^0x/, ''), usdtOwner: () => OWNER };
  const api = make(src, names, stubs, 'xtStartBoth, startPending, startsKept');
  const run = { say() {}, take() {}, to: { label: 'Start' } }, plan = { ethLeg: 10n ** 16n, bLeg: 1000n, shares: 5000n, owner: OWNER };
  return { api, log, r, go: () => api.xtStartBoth({ run, r, wei: 10n ** 16n, st: null, plan }), pending: () => api.startPending(r) };
}
const kinds = (w) => w.log.map((x) => x[0]).join(',');
test('xtStartBoth in two steps: kept before the add, dropped when the share is shielded, settled', async () => {
  const w = both();
  assert.equal(await w.go(), '0xtx2');
  assert.equal(kinds(w), 'call,send,wait,send,wait,settle', 'the add is run as a call, sent, waited for; then the shield, sent, waited for; then the settle');
  assert.equal(w.pending(), null, 'once shielded the record goes');
  assert.equal(w.log.find((x) => x[0] === 'settle')[1], '0xtx2');
});
test('xtStartBoth: a no to the add leaves nothing to finish and gives its index back', async () => {
  const w = both({ sendErrAt: 1 });
  await assert.rejects(w.go(), /Cancelled/);
  assert.equal(w.pending(), null); assert.deepEqual(w.log.filter((x) => x[0] === 'release'), [['release', 5]]);
});
test('xtStartBoth: once the add has landed, a no to the shield keeps the record and the index, and says the shares are public', async () => {
  const w = both({ sendErrAt: 2 });
  await assert.rejects(w.go(), (e) => e.said && /still public liquidity/.test(e.message) && /Press Start the pool again/.test(e.message));
  assert.equal(w.pending()?.index, 5, 'kept, with the index the share was built at'); assert.ok(!w.log.some((x) => x[0] === 'release'), 'the index stays');
  assert.ok(!w.log.some((x) => x[0] === 'settle'));
});
test('xtStartBoth: a shield that is replaced or dropped leaves the shares public, so the record stays; an add that is dropped or reverted made none, so it goes', async () => {
  const replaced = both({ waitErr: { '0xtx2': Object.assign(new Error('replaced'), { dropped: true }) } });
  await assert.rejects(replaced.go(), /replaced/); assert.ok(replaced.pending(), 'the shield was replaced: the shares are still public'); assert.ok(!replaced.log.some((x) => x[0] === 'release'));
  const addDropped = both({ waitErr: { '0xtx1': Object.assign(new Error('never went in'), { dropped: true }) } });
  await assert.rejects(addDropped.go(), /never went in/); assert.equal(addDropped.pending(), null); assert.deepEqual(addDropped.log.filter((x) => x[0] === 'release'), [['release', 5]]);
  const addReverted = both({ waitErr: { '0xtx1': new Error('The transaction reverted.') } });
  await assert.rejects(addReverted.go(), /reverted/); assert.equal(addReverted.pending(), null, 'an add that reverted made no shares');
  const addPending = both({ waitErr: { '0xtx1': Object.assign(new Error('Still pending.'), { pending: true }) } });
  await assert.rejects(addPending.go(), /pending/); assert.ok(addPending.pending(), 'an add not known to have landed is read at the next press, not dropped');
});
test('xtStartBoth: a start the pool refuses sends nothing and says no pool was started', async () => {
  const w = both({ sim: 'revert' });
  await assert.rejects(w.go(), (e) => e.said && /^No pool was started: refused/.test(e.message));
  assert.ok(!w.log.some((x) => x[0] === 'send' || x[0] === 'batch')); assert.equal(w.pending(), null);
});
test('xtStartBoth with a wallet that batches: a token still to be added is not run as a call first (it would always revert), a token already in is', async () => {
  const fresh = both({ batch: true, registered: false });
  await fresh.go();
  assert.equal(kinds(fresh), 'batch,wait,settle', 'the registration, the add and the shield go as one batch, with no call before it');
  assert.deepEqual(fresh.log.find((x) => x[0] === 'batch'), ['batch', 3]); assert.equal(fresh.pending(), null, 'a batch lands whole: no record is needed');
  const known = both({ batch: true, registered: true });
  await known.go();
  assert.equal(kinds(known), 'call,batch,wait,settle', 'a token in the pool is checked first, as before'); assert.deepEqual(known.log.find((x) => x[0] === 'batch'), ['batch', 2]);
});
