// dapp/bridge/track.js: the bridge page reads the front page's bridge journals (burndep-ux on the way in, crossout-ux on the way out)
// into rows, says which step each is at and what it waits on its holder for, and reads none of a record's signing material.
//   node --test tests/bridge-track.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { checkNote, readBridges, inRow, outRow, inActs, outActs, rowNote, inDue, outDue, liveLine, nextOf, readyNow, fmtAmount, limitLine, limitsSaid, CUSDT_ID, ROUTES, ethSpan, btcSpan, satsOut, satsBack, costLine, LIMITS, IN_PREFIX, OUT_PREFIX, PLAN_KEY, TAC_ID, TETH_ID, KEEP_DONE_MS } from '../dapp/bridge/track.js';
import { CROSSOUT_BETA_CAP_RAW, CROSSOUT_TETH_CAP_RAW, CROSSOUT_TETH_MIN_RAW, CROSSOUT_CBTC_CAP_RAW, CROSSOUT_CBTC_MIN_RAW, CROSSOUT_CUSD_CAP_RAW, CROSSOUT_CUSD_MIN_RAW, CROSSOUT_CUSDT_DEC, CROSSOUT_CUSDT_CAP_RAW, CROSSOUT_CUSDT_MIN_RAW } from '../dapp/crossout-ux.js';
import { BURNDEP_BETA_CAP_RAW } from '../dapp/burndep-ux.js';
import { makeCrossoutMintReveal } from '../dapp/crossout-mint-reveal.js';

const NOW = 1_760_000_000_000;
const PUB = '02' + 'ab'.repeat(32);
const SECRET = 'cd'.repeat(32);
const big = (v) => ({ __big: String(v) });   // how burndep-ux journals an amount

function store(map) {
  const keys = Object.keys(map);
  return { get length() { return keys.length; }, key: (i) => keys[i] ?? null, getItem: (k) => (k in map ? map[k] : null) };
}

const inRec = (o = {}) => ({
  id: 'aa'.repeat(32) + ':0', network: 'mainnet', walletPub: PUB, path: 'reflected', stage: 'rburn-mined', createdAt: NOW - 3600e3,
  source: { txid: 'aa'.repeat(32), vout: 0, assetId: 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', ticker: 'TAC', amount: big(123_45000000n), blinding: big(77n) },
  burn: { txid: 'bb'.repeat(32), hex: '00', commitTxid: 'cc'.repeat(32) }, burnHeight: 972_100,
  notePriv: SECRET, mint: { dest: { blinding: big(9n) } }, ...o,
});
const outRec = (o = {}) => ({
  id: '0x' + 'dd'.repeat(32), network: 'mainnet', walletPub: PUB, stage: 'settled', createdAt: NOW - 600e3,
  source: { nullifier: '0x' + 'dd'.repeat(32), value: '500000000', amount: '490000000', assetId: '0x' + TETH_ID, ticker: 'tETH' },
  destXonly: 'ee'.repeat(32), settle: { txHash: 'ff'.repeat(32), claimId: '0x' + '11'.repeat(32), ethBlock: 26_225_900, claimIdVerified: true },
  ...o,
});

test('a bridge in reads its asset, amount, step and transactions', () => {
  const r = inRow(inRec(), NOW);
  assert.equal(r.dir, 'in'); assert.equal(r.asset, 'tac'); assert.equal(r.amount, 123_45000000n);
  assert.equal(r.at, 2); assert.equal(r.btcTx, 'bb'.repeat(32)); assert.equal(r.btcHeight, 972_100);
  assert.equal(r.href, '/#bridge'); assert.equal(r.due, '');
});

test('a bridge that paid someone else ends in a payment, and shows no more of the record', () => {
  const stealth = { recipientPub: '02' + 'ee'.repeat(32), recipientName: 'alice.wei', deadline: '1800000000', ownerPub: '0x' + 'dd'.repeat(32), lockLeaf: '0x' + 'ab'.repeat(32), refundPub: '0x' + 'cc'.repeat(32), ephemeralPub: '02' + 'ff'.repeat(32) };
  const own = inRow(inRec({ stage: 'minted', mintedAt: NOW }), NOW), paid = inRow(inRec({ stage: 'minted', mintedAt: NOW, stealth }), NOW);
  assert.equal(own.paid, false); assert.equal(paid.paid, true);
  assert.equal(own.steps[3], 'Minted privately'); assert.deepEqual(paid.steps, [...own.steps.slice(0, 3), 'Paid privately']);
  assert.equal(paid.done, true); assert.equal(paid.at, 4);
  const text = JSON.stringify(paid, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.ok(!text.includes('alice.wei') && !text.includes(stealth.recipientPub) && !text.includes(stealth.lockLeaf), 'the row says it paid someone, not whom');
});

test('nothing secret leaves a record', () => {
  const rows = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([inRec()]), [OUT_PREFIX + PUB]: JSON.stringify([outRec()]) }), NOW);
  const text = JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.ok(!text.includes(SECRET), 'the note key');
  assert.ok(!text.includes('"blinding"'), 'a blinding');
  assert.ok(!text.includes('"hex"'), 'a signed transaction');
});

test('the presses a bridge in waits on, as the front page names them', () => {
  assert.equal(inDue(inRec({ stage: 'traced' }), NOW), 'Burn it');
  assert.equal(inDue(inRec({ stage: 'rfolded' }), NOW), 'Mint now');
  assert.equal(inDue(inRec({ stage: 'rfolded', arm: { ok: true } }), NOW), '', 'the relay holds an armed mint');
  assert.equal(inDue(inRec({ stage: 'folded', lastError: { message: 'x', until: NOW + 3600e3 } }), NOW), '', 'held for the day');
  assert.equal(inDue(inRec({ stage: 'folded', lastError: { message: 'x', relay: true } }), NOW), '', 'the page asks again');
  assert.equal(inDue(inRec({ stage: 'stopped' }), NOW), 'Move it back');
  assert.equal(inDue(inRec({ stage: 'burn-submitted', submittedAt: NOW - 13 * 3600e3 }), NOW), 'Move it back');
  assert.equal(inDue(inRec({ stage: 'burn-submitted', submittedAt: NOW - 3600e3 }), NOW), '');
  assert.equal(inDue(inRec({ stage: 'not-recorded' }), NOW), 'Recover');
  assert.equal(inDue(inRec({ stage: 'not-recorded', source: { p2tr: true } }), NOW), '', 'a cross-out note has nothing to recover');
  assert.equal(inDue(inRec({ stage: 'rburn-sent', lastError: { message: 'x' }, errorCount: 3 }), NOW), 'Try again or cancel');
});

test('a bridge out: its step, its press, and its Ethereum block', () => {
  const r = outRow(outRec());
  assert.equal(r.asset, 'teth'); assert.equal(r.amount, 490000000n); assert.equal(r.at, 1);
  assert.equal(r.ethTx, '0x' + 'ff'.repeat(32)); assert.equal(r.ethBlock, 26_225_900); assert.equal(r.href, '/#private/bitcoin/out');
  assert.equal(outDue(outRec({ stage: 'covered' })), 'Send to Bitcoin');
  assert.equal(outDue(outRec({ stage: 'covered', lastError: { message: 'x', fundWait: true, needSats: 1214, haveSats: 0 } })), 'Add bitcoin', 'a Bitcoin step waiting for sats asks for them');
  assert.equal(outDue(outRec({ stage: 'mint-rejected' })), 'Send it again');
  assert.equal(outDue(outRec({ stage: 'mint-rejected', attempts: [{}, {}] })), 'Look at it', 'after the third step the front page offers none');
  assert.equal(outDue(outRec({ settle: { claimIdVerified: false } })), 'Look at it');
  assert.equal(outDue(outRec({ stage: 'mint-submitted', lastError: { message: 'x' }, errorCount: 6, feeWait: true })), '', 'a fee wait is not the holder’s');
  assert.equal(outRow(outRec({ stage: 'mint-submitted', mint: { revealTxid: '12'.repeat(32) } })).btcTx, '12'.repeat(32));
});

test('every journal in the browser, ordered: what needs its holder, then what is under way, then arrivals', () => {
  const rows = readBridges(store({
    [IN_PREFIX + PUB]: JSON.stringify([inRec({ id: 'a', createdAt: NOW - 1e3 }), inRec({ id: 'b', stage: 'minted', mintedAt: NOW - 1e3 }), inRec({ id: 'c', stage: 'minted', mintedAt: NOW - KEEP_DONE_MS - 1 })]),
    [OUT_PREFIX + PUB]: JSON.stringify([outRec({ id: 'd', stage: 'covered' })]),
    'tacit-something-else': '[{"stage":"x"}]',
    [IN_PREFIX + '03' + '00'.repeat(32)]: 'not json',
  }), NOW);
  assert.deepEqual(rows.map((r) => r.id), ['d', 'a', 'b']);
});

test('a bridge whose TAC came back (moved back, or returned by the recovery) is done with: it waits on nobody, and goes after three days', () => {
  for (const stage of ['reclaimed', 'recovered']) {
    const row = inRow(inRec({ id: stage, stage, updatedAt: NOW - 1e3, lastError: { message: 'old' } }), NOW);
    assert.equal(row.back, true, stage); assert.equal(row.held, false, stage); assert.equal(row.due, '', stage); assert.deepEqual(row.acts, [], stage);
    const old = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([inRec({ id: stage, stage, updatedAt: NOW - KEEP_DONE_MS - 1 })]) }), NOW);
    assert.deepEqual(old.map((r) => r.id), [], `${stage}: dropped after ${KEEP_DONE_MS / 86400e3} days`);
    const recent = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([inRec({ id: stage, stage, updatedAt: NOW - 1e3 })]) }), NOW);
    assert.deepEqual(recent.map((r) => r.id), [stage], `${stage}: listed while recent`);
  }
  assert.equal(inRow(inRec({ id: 's', stage: 'stopped' }), NOW).held, true, 'a stopped bridge still waits on its holder');
});

test('Ethereum blocks read as a time: minutes, then hours from an hour and a half', () => {
  assert.equal(ethSpan(1), '1 min');
  assert.equal(ethSpan(100), '20 min');
  assert.equal(ethSpan(444), '89 min');
  assert.equal(ethSpan(450), '2 hours');
  assert.equal(ethSpan(3000), '10 hours');
});

test('storage that refuses to be read is no bridges', () => {
  assert.deepEqual(readBridges({ get length() { throw new Error('denied'); } }, NOW), []);
  assert.deepEqual(readBridges(null, NOW), []);
});

test('where a bridge really is, from the chains', () => {
  const live = { btcAttested: 972_090, ethCovered: 26_225_800, txs: new Map() };
  assert.match(liveLine(inRow(inRec(), NOW), live), /10 blocks behind/);
  assert.match(liveLine(inRow(inRec(), NOW), { ...live, btcAttested: 972_100 }), /has reached this block/);
  assert.equal(liveLine(inRow(inRec({ stage: 'rfolded' }), NOW), { ...live, btcAttested: 972_200 }), '');
  const pending = inRow(inRec({ stage: 'rburn-sent', burnHeight: undefined }), NOW);
  assert.match(liveLine(pending, { ...live, txs: new Map([['bb'.repeat(32), { confirmed: false }]]) }), /mempool/);
  assert.match(liveLine(outRow(outRec()), live), /the proof is about 20 min short of it/);
  assert.match(liveLine(outRow(outRec()), { ...live, ethCovered: live.ethCovered - 900 }), /the proof is about 3 hours short of it/);
  assert.match(liveLine(outRow(outRec()), { ...live, ethCovered: 26_225_900 }), /proof has reached this block/);
  assert.equal(liveLine(inRow(inRec({ stage: 'minted', mintedAt: NOW }), NOW), live), '');
});

test('what goes on by itself and what needs the page', () => {
  assert.deepEqual(nextOf(inRow(inRec(), NOW)), { due: '', self: true });
  assert.deepEqual(nextOf(inRow(inRec({ stage: 'rfolded', arm: { ok: true } }), NOW)), { due: '', self: true });
  assert.deepEqual(nextOf(inRow(inRec({ stage: 'traced' }), NOW)), { due: 'Burn it', self: false });
  assert.deepEqual(nextOf(outRow(outRec())), { due: '', self: true });
  assert.deepEqual(nextOf(outRow(outRec({ stage: 'covered' }))), { due: 'Send to Bitcoin', self: false });
});

test('amounts in eight decimals, trimmed to the asset’s places', () => {
  assert.equal(fmtAmount(123_45000000n, 4), '123.45');
  assert.equal(fmtAmount(1_000_00000000n, 4), '1,000');
  assert.equal(fmtAmount({ __big: '490000000' }, 6), '4.9');
  assert.equal(fmtAmount(1n, 8), '0.00000001');
});

// ── tETH ──
const tethBack = (o = {}) => inRec({ source: { txid: 'aa'.repeat(32), vout: 1, assetId: '0x' + TETH_ID, ticker: 'tETH', amount: big(30_000_000n), blinding: big(5n) }, ...o });

test('tETH coming back from Bitcoin is a tETH row, read in its own places', () => {
  const r = inRow(tethBack({ stage: 'rburn-mined' }), NOW);
  assert.equal(r.asset, 'teth'); assert.equal(r.dir, 'in'); assert.equal(r.amount, 30_000_000n);
  assert.equal(r.href, '/#private/bitcoin/back'); assert.equal(r.at, 2); assert.equal(r.btcTx, 'bb'.repeat(32));
  assert.equal(fmtAmount(r.amount, 6), '0.3');
  assert.equal(inDue(tethBack({ stage: 'rfolded' }), NOW), 'Mint now');
  const rows = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([tethBack({ id: 't1', createdAt: NOW - 1e3 }), inRec({ id: 'x1', createdAt: NOW - 2e3 })]) }), NOW);
  assert.deepEqual(rows.map((x) => [x.id, x.asset]), [['t1', 'teth'], ['x1', 'tac']]);
});

test('a tETH record that names only its ticker is still tETH', () => {
  assert.equal(inRow(tethBack({ source: { ticker: 'tETH', amount: big(1n) } }), NOW).asset, 'teth');
  assert.equal(outRow(outRec({ source: { ticker: 'tETH', amount: '5' } })).asset, 'teth');
});

test('the limits the page shows are the ones the bridge enforces', () => {
  // to Bitcoin: dapp/crossout-ux.js; back from it: dapp/burndep-ux.js; the TAC minimum is the front page's own asset table
  assert.equal(LIMITS.tac.out.max, CROSSOUT_BETA_CAP_RAW);
  assert.equal(LIMITS.tac.in.max, BURNDEP_BETA_CAP_RAW);
  assert.equal(LIMITS.teth.out.max, CROSSOUT_TETH_CAP_RAW);
  assert.equal(LIMITS.teth.out.min, CROSSOUT_TETH_MIN_RAW);
  assert.equal(LIMITS.teth.in.max, CROSSOUT_TETH_CAP_RAW);   // tacit.js hands the burn-deposit module the same tETH cap
  const front = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
  const tacMin = /tac: \{ key: 'tac'[^\n]*?\bmin: ([0-9_]+)n/.exec(front);
  assert.ok(tacMin, 'the front page keeps a TAC minimum');
  assert.equal(LIMITS.tac.out.min, BigInt(tacMin[1].replaceAll('_', '')));
  const tacit = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
  assert.match(tacit, /ticker: 'tETH', capRaw: CROSSOUT_TETH_CAP_RAW \}\] : \[\]\),/, 'the way back for tETH takes the same cap');
  // cBTC and cUSD: the same caps both ways (tacit.js hands each module _bridgedPoolAssets), the crossing's minimum the way out
  for (const [k, cap, min] of [['cbtc', CROSSOUT_CBTC_CAP_RAW, CROSSOUT_CBTC_MIN_RAW], ['cusd', CROSSOUT_CUSD_CAP_RAW, CROSSOUT_CUSD_MIN_RAW]]) {
    assert.equal(LIMITS[k].out.max, cap); assert.equal(LIMITS[k].out.min, min); assert.equal(LIMITS[k].in.max, cap);
  }
  assert.match(tacit, /\['cBTC', CROSSOUT_CBTC_CAP_RAW, CROSSOUT_CBTC_MIN_RAW\], \['cUSD', CROSSOUT_CUSD_CAP_RAW, CROSSOUT_CUSD_MIN_RAW\]/, 'cBTC and cUSD cross with those caps');
  // cUSDT: USDT's own six decimals, 2 to 100 USDT a bridge, and the id the front page and this page both name it by
  assert.equal(LIMITS.cusdt.out.max, CROSSOUT_CUSDT_CAP_RAW); assert.equal(LIMITS.cusdt.out.min, CROSSOUT_CUSDT_MIN_RAW); assert.equal(LIMITS.cusdt.in.max, CROSSOUT_CUSDT_CAP_RAW);
  assert.equal(ROUTES.cusdt.dec, CROSSOUT_CUSDT_DEC); assert.equal(CROSSOUT_CUSDT_DEC, 6);
  assert.match(tacit, /capRaw: CROSSOUT_CUSDT_CAP_RAW, minRaw: CROSSOUT_CUSDT_MIN_RAW, dec: CROSSOUT_CUSDT_DEC/, 'cUSDT crosses with those limits and decimals');
  assert.match(front, new RegExp(`cusdt: \\{ id: '${CUSDT_ID}', ticker: 'cUSDT', dp: 2, dec: 6 \\}`), 'the front page names cUSDT by the same id');
});

test('cUSDT reads in six decimals and is told from the eight-decimal assets', () => {
  assert.equal(limitLine('cusdt', 'out'), '2 to 100 cUSDT a bridge while it is new');
  assert.equal(limitLine('cusdt', 'in'), 'Up to 100 cUSDT a bridge while it is new');
  assert.equal(fmtAmount(2_500_000n, 2, 6), '2.5'); assert.equal(fmtAmount(1_234_567n, 6, 6), '1.234567'); assert.equal(fmtAmount(1_000_000_000n, 2, 6), '1,000');
  assert.equal(fmtAmount(250_000_000n, 2), '2.5', 'the default is still eight decimals');
  assert.match(limitsSaid(), /cUSDT 2 to 100 to Bitcoin and up to 100 back/);
  const page = readFileSync(new URL('../dapp/bridge/index.html', import.meta.url), 'utf8');
  assert.ok(page.includes(limitsSaid()), 'the page\'s own sentence of the limits is the one built here');
  assert.match(page, /data-asset="cusdt"/, 'the page has a USDT tab');
  const rows = readBridges(store({ [OUT_PREFIX + PUB]: JSON.stringify([outRec({ source: { nullifier: '0x' + 'dd'.repeat(32), value: '5000000', amount: '4500000', assetId: '0x' + CUSDT_ID, ticker: 'cUSDT' } })]) }), NOW);
  assert.equal(rows[0].asset, 'cusdt'); assert.equal(rows[0].amount, 4_500_000n);
  assert.equal(costLine('cusdt', 'out', { satvb: 2, relay: { cusdt: 500_000n } }), 'From 0.5 cUSDT to the relay and 1,214 sats on Bitcoin');
});

test('the line under the steps says what one bridge takes', () => {
  assert.equal(limitLine('tac', 'in'), 'Up to 1,000 TAC a bridge while it is new');
  assert.equal(limitLine('tac', 'out'), '20 to 1,000 TAC a bridge while it is new');
  assert.equal(limitLine('teth', 'out'), '0.001 to 0.5 tETH a bridge while it is new');
  assert.equal(limitLine('teth', 'in'), 'Up to 0.5 tETH a bridge while it is new');
  assert.equal(limitLine('cbtc', 'out'), '0.00001 to 0.5 cBTC a bridge while it is new');
  assert.equal(limitLine('cusd', 'out'), '10 to 1,000 cUSD a bridge while it is new');
});

test('a two-step bridge at its burn asks for no press when the page sends it, as the front page decides (brDue)', () => {
  const traced = (o = {}) => inRec({ path: 'deposit', stage: 'traced', ...o });
  assert.equal(inDue(traced(), NOW), 'Burn it');
  assert.equal(inDue(traced(), NOW, { burn: { maxRate: 20 } }), '', 'its plan sends the burn');
  assert.equal(inDue(traced({ checkWait: { at: NOW, go: true } }), NOW), '', 'a pressed burn waits on the history check');
  assert.equal(inDue(traced({ checkWait: { at: NOW, go: false } }), NOW), 'Burn it', 'a check the page started on its own still wants the press');
  assert.equal(inDue(traced({ feeWait: { rate: 40, max: 20 } }), NOW, { burn: { maxRate: 20 } }), 'Burn it', 'over the rate it was allowed');
  assert.equal(inDue(traced({ lastError: { message: 'x' }, checkWait: { at: NOW, go: true } }), NOW), 'Burn it');
  const row = inRow(traced({ checkWait: { at: NOW, go: true } }), NOW);
  assert.equal(row.checking, true);
  assert.equal(liveLine(row, null), 'Its history is being checked before its burn');
  assert.equal(nextOf(row).due, '');
  assert.equal(nextOf(row).self, false, 'the burn still needs the front page open');
});

test('the bridge page reads the front page\'s plans for each key', () => {
  const rec = inRec({ path: 'deposit', stage: 'traced' });
  const plans = { [PUB]: { [rec.id]: { at: NOW, burn: { maxRate: 20 } } } };
  const [row] = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([rec]), [PLAN_KEY]: JSON.stringify(plans) }), NOW);
  assert.equal(row.due, '');
  const [bare] = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([rec]) }), NOW);
  assert.equal(bare.due, 'Burn it');
  const [broken] = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([rec]), [PLAN_KEY]: '{not json' }), NOW);
  assert.equal(broken.due, 'Burn it', 'unreadable plans are no plans');
});

test('what a way costs is the app\'s own figure, at the live fee rate', () => {
  // The way out: the page\'s sats are the Bitcoin step\'s own estimate.
  const mr = makeCrossoutMintReveal({ secp: {} });
  for (const rate of [1, 2, 3, 7.5, 40]) assert.equal(satsOut(rate), mr.estimateSats({ feeRate: rate, dust: 546 }), `at ${rate} sat/vB`);
  // The way back is bridgeCost's 'reflected' path for a P2TR note; its constants are pinned to the source it is built from.
  const src = readFileSync(new URL('../dapp/burndep-ux.js', import.meta.url), 'utf8');
  assert.ok(/feeFor\(p2tr \? 218 : 228\)/.test(src) && /commitVb = \(n\) => 85 \+ 68 \* n/.test(src) && /Math\.max\(500, Math\.ceil\(vb \* at\)\)/.test(src), 'bridgeCost no longer reads as satsBack expects');
  assert.equal(satsBack(1), 1000); assert.equal(satsBack(2), 1000);
  assert.equal(satsBack(5), Math.ceil(218 * 5) + Math.ceil(153 * 5));
});

test('the tile\'s cost line says what a way costs now, and nothing when it cannot say', () => {
  const c = { satvb: 2, relay: { teth: 52_241n, tac: 400_000_000n }, ethUsd: 2500, btcUsd: 80_000 };
  assert.equal(costLine('teth', 'out', c), 'From $2.28 now: 0.00052 tETH to the relay and 1,214 sats on Bitcoin');
  assert.equal(costLine('teth', 'in', c), 'About $0.80 now: 1,000 sats on Bitcoin; Tacit covers the Ethereum side');
  assert.equal(costLine('teth', 'out', { ...c, ethUsd: null }), 'From 0.00052 tETH to the relay and 1,214 sats on Bitcoin', 'without a price it names the amounts only');
  assert.equal(costLine('teth', 'out', { ...c, relay: { teth: 25_899n }, ethUsd: null }), 'From 0.00026 tETH to the relay and 1,214 sats on Bitcoin', 'a small fee is said to two figures, not cut to less than it is');
  assert.equal(costLine('teth', 'out', { ...c, relay: { teth: 9_999n }, ethUsd: null }), 'From 0.0001 tETH to the relay and 1,214 sats on Bitcoin', 'and never as nothing');
  assert.equal(costLine('tac', 'out', c), 'From 4 TAC to the relay and 1,214 sats on Bitcoin');
  assert.equal(costLine('tac', 'in', c), '', 'TAC\'s way in has two steps and is priced on its own sheet');
  assert.equal(costLine('cbtc', 'in', c), 'About 1,000 sats on Bitcoin; Tacit covers the Ethereum side', 'cBTC comes back as tETH does');
  assert.equal(costLine('cusd', 'out', { ...c, relay: { cusd: 50_000_008n } }), 'From 0.5 cUSD to the relay and 1,214 sats on Bitcoin');
  assert.equal(costLine('teth', 'out', { ...c, satvb: null }), '', 'no fee rate, no line');
  assert.equal(costLine('teth', 'out', { ...c, relay: {} }), '', 'no relay floor, no line for the way out');
});

test('Bitcoin blocks read as a time', () => {
  assert.equal(btcSpan(1), '10 min'); assert.equal(btcSpan(8), '80 min'); assert.equal(btcSpan(9), '2 hours'); assert.equal(btcSpan(24), '4 hours');
  assert.match(liveLine(inRow(inRec(), NOW), { btcAttested: 972_090, ethCovered: 1, txs: new Map() }), /10 blocks behind it, about 2 hours$/);
});

test('a step the chains say is ready for its holder is named before the journal catches up', () => {
  const covered = { ethCovered: 26_226_000, btcAttested: 972_090, txs: new Map() };
  const waiting = outRow(outRec({ stage: 'settled' }));
  assert.equal(readyNow(waiting, covered), 'Send to Bitcoin', 'the proof has reached the burn, and the Bitcoin step needs the key');
  assert.equal(readyNow(waiting, { ...covered, ethCovered: 26_225_000 }), '', 'not yet');
  assert.deepEqual(nextOf(waiting, covered), { due: 'Send to Bitcoin', self: false });
  assert.deepEqual(nextOf(waiting, covered, true), { due: '', self: true }, 'with the key open on the page that moves bridges on, that page takes the step: it is not put to the holder');
  const stuck = outRow(outRec({ stage: 'covered', lastError: { message: 'bad', fundWait: true }, errorCount: 0 }), NOW);
  assert.equal(nextOf(stuck, covered, true).due, stuck.due, 'while a step the journal itself says needs the holder (a coin to add, a try to repeat) is still put to them');
  assert.deepEqual(nextOf(waiting, null), { due: '', self: true }, 'with no reading it is the journal\'s word');
  assert.equal(readyNow(outRow(outRec({ stage: 'minted', mintedAt: NOW })), covered), '', 'an arrival is not due');
  const burn = inRow(inRec({ stage: 'rburn-mined', burnHeight: 972_080 }), NOW);
  assert.equal(readyNow(burn, covered), 'Mint now', 'a burn the proof has reached waits for its mint');
  assert.equal(readyNow(inRow(inRec({ stage: 'rburn-mined', burnHeight: 972_100 }), NOW), covered), '', 'one it has not reached does not');
  assert.equal(readyNow(inRow(inRec({ stage: 'rburn-mined', burnHeight: 972_080, arm: { ok: true } }), NOW), covered), '', 'the relay mints an armed one');
});

test('a bridge waiting on its history check says where the check stands, and nothing once that is old news', () => {
  const traced = (cw) => inRec({ path: 'deposit', stage: 'traced', checkWait: { go: true, burn: { hex: 'ff'.repeat(10) }, ...cw } });
  const note = (cw) => inRow(traced(cw), NOW).checkNote;
  assert.equal(note({ at: NOW, progress: { state: 'queued', ahead: 2, runningSec: 0 } }), '2 checks are ahead of it');
  assert.equal(note({ at: NOW, progress: { state: 'queued', ahead: 1, runningSec: 0 } }), 'one check is ahead of it');
  assert.equal(note({ at: NOW, progress: { state: 'queued', ahead: 0, runningSec: 0 } }), 'it is next');
  assert.equal(note({ at: NOW, progress: { state: 'running', ahead: 0, runningSec: 30 } }), 'checking now');
  assert.equal(note({ at: NOW - 90e3, progress: { state: 'running', ahead: 0, runningSec: 150 } }), 'checking now, 4 min in', 'the time since the answer is added');
  assert.equal(note({ at: NOW, progress: { state: 'running', ahead: 0, runningSec: 90, phase: 'reading', done: 88, total: 132 } }), 'reading its history from Bitcoin, 88 of 132 transactions');
  assert.equal(note({ at: NOW, progress: { state: 'running', ahead: 0, runningSec: 200, phase: 'verifying', done: 132, total: 132 } }), 'checking its 132 transactions now');
  assert.equal(note({ at: NOW, progress: { state: 'running', ahead: 0, runningSec: 200, phase: 'headers', done: 132, total: 132 } }), 'checking its 132 transactions now');
  assert.equal(note({ at: NOW, progress: { state: 'running', ahead: 0, runningSec: 200, phase: 'reading', done: 0, total: 0 } }), 'checking now, 3 min in', 'with nothing counted it says what it can');
  assert.equal(note({ at: NOW, busy: true }), 'the check is busy with others, so it asks again by itself');
  assert.equal(note({ at: NOW - 4 * 60e3, progress: { state: 'queued', ahead: 2, runningSec: 0 } }), '', 'an answer from minutes ago says nothing');
  assert.equal(note({ at: NOW }), '');
  assert.equal(inRow(traced({ at: NOW, progress: { state: 'queued', ahead: 2 } }), NOW).checkNote.includes('hex'), false);
  const row = inRow(traced({ at: NOW, progress: { state: 'queued', ahead: 2, runningSec: 0 } }), NOW);
  assert.equal(liveLine(row, null), 'Its history is being checked before its burn: 2 checks are ahead of it');
  assert.equal(inRow(inRec({ path: 'deposit', stage: 'traced', lastError: { message: 'x' }, checkWait: { at: NOW, busy: true } }), NOW).checkNote, '', 'a failed bridge names its failure, not a wait');
  assert.equal(checkNote(null, NOW), '');
});

test('the front page words the same wait, from the same facts', () => {
  const src = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
  const m = /function brCheckNote\(cw\) \{[\s\S]*?\n\}\n/.exec(src);
  assert.ok(m, 'the front page has brCheckNote');
  const real = Date.now; Date.now = () => NOW;
  try {
    const brCheckNote = new Function(`${m[0]}; return brCheckNote;`)();
    const cases = [
      { at: NOW, progress: { state: 'queued', ahead: 2, runningSec: 0 } }, { at: NOW, progress: { state: 'queued', ahead: 1, runningSec: 0 } },
      { at: NOW, progress: { state: 'queued', ahead: 0, runningSec: 0 } }, { at: NOW, progress: { state: 'running', ahead: 0, runningSec: 30 } },
      { at: NOW - 90e3, progress: { state: 'running', ahead: 0, runningSec: 150 } }, { at: NOW, busy: true }, { at: NOW - 4 * 60e3, busy: true }, { at: NOW }, null,
      { at: NOW, progress: { state: 'running', ahead: 0, runningSec: 90, phase: 'reading', done: 88, total: 132 } }, { at: NOW, progress: { state: 'running', ahead: 0, runningSec: 200, phase: 'verifying', done: 132, total: 132 } },
      { at: NOW, progress: { state: 'running', ahead: 0, runningSec: 200, phase: 'reading', done: 0, total: 0 } },
    ];
    for (const cw of cases) {
      const page = brCheckNote(cw), bridge = checkNote(cw, NOW);
      const sentence = bridge ? bridge[0].toUpperCase() + bridge.slice(1) + '.' : '';
      assert.equal(page.replace('so this page asks', 'so it asks'), sentence, JSON.stringify(cw));
    }
  } finally { Date.now = real; }
});

// the presses a row offers its holder are the front page's row buttons: one main press for what waits on the holder, the rest alongside
test('inActs and outActs: the presses a bridge offers', () => {
  const kinds = (xs) => xs.map((a) => a.kind + (a.main ? '*' : '')).join();
  const inr = (stage, extra = {}) => ({ id: 'x', stage, path: 'reflected', source: {}, ...extra });
  assert.equal(kinds(inActs(inr('traced'), 'Burn it')), 'burn*');
  assert.equal(kinds(inActs(inr('rfolded'), 'Mint now')), 'mint*');
  assert.equal(kinds(inActs(inr('stopped'), 'Move it back')), 'reclaim*');
  assert.equal(kinds(inActs(inr('not-recorded'), 'Recover')), 'recover*,recheck');
  assert.equal(kinds(inActs(inr('not-recorded', { source: { p2tr: true } }), '')), 'recheck', 'a note that cannot be recovered can still be looked at again');
  assert.equal(kinds(inActs(inr('migrate-signed', { lastError: { message: 'x' }, errorCount: 3 }), 'Try again or cancel')), 'poll*,cancel');
  assert.equal(kinds(inActs(inr('burn-mined', { lastError: { message: 'x' } }), '')), 'poll', 'any other bridge that is failing offers Try again');
  assert.equal(kinds(inActs(inr('burn-mined'), '')), '', 'one that goes on by itself offers none');
  assert.equal(kinds(inActs(inr('recovered', { lastError: { message: 'x' } }), '')), '', 'a bridge set aside offers none');
  const out = (stage, extra = {}) => ({ id: 'y', stage, source: {}, ...extra });
  const T0 = NOW;
  assert.equal(kinds(outActs(out('settled', { settle: { claimIdVerified: false } }), T0)), 'recheck*');
  assert.equal(kinds(outActs(out('settling', { createdAt: T0 - 3600e3 }), T0)), 'poll');
  assert.equal(kinds(outActs(out('settling', { createdAt: T0 - 3 * 3600e3 }), T0)), 'poll,cancel', 'an old burn that has not been seen can be cancelled');
  assert.equal(kinds(outActs(out('covered', { lastError: { message: 'crossout-ux: Bitcoin fees are high right now' }, errorCount: 1 }), T0)), 'force*');
  assert.equal(kinds(outActs(out('covered', { lastError: { fundWait: true, message: 'x' } }), T0)), 'poll', 'waiting for sats: Check again');
  assert.equal(kinds(outActs(out('covered'), T0)), '', 'covered with nothing wrong goes on by itself');
  assert.equal(kinds(outActs(out('mint-rejected', { settle: { claimIdVerified: true }, attempts: [1] }), T0)), 'retry*');
  assert.equal(kinds(outActs(out('mint-rejected', { settle: { claimIdVerified: true }, attempts: [1, 2] }), T0)), '', 'the third rejection is looked at, not sent again');
  assert.equal(kinds(outActs(out('mint-signed', { lastError: { message: 'x' }, errorCount: 3 }), T0)), 'poll,resign');
  assert.equal(kinds(outActs(out('mint-signed', { lastError: { message: 'x' }, errorCount: 1 }), T0)), 'poll');
  assert.equal(kinds(outActs(out('minted'), T0)), '');
  // rows carry them
  const row = outRow(out('covered', { lastError: { message: 'Bitcoin fees are high right now' }, errorCount: 1, source: { value: big(5), amount: big(4) } }), T0);
  assert.deepEqual(row.acts.map((a) => a.kind), ['force']);
  assert.deepEqual(inRow(inr('minted'), T0).acts, [], 'an arrived bridge offers none');
});

// a held row says what holds it, with the cost in view; ids that are not 64 hex digits are never made into links; Recover is for TAC only
test('rows: the note, the ids, Recover and a stalled move', () => {
  const T0 = NOW, tx = 'ab'.repeat(32);
  // the note: the fee a burn waits for, the error a Bitcoin step keeps meeting, and what a plain-looking press would do
  const held = outRow({ id: '0x' + 'c1'.repeat(32), stage: 'covered', source: { value: big(5), amount: big(4), assetId: '0x' + TETH_ID }, settle: { txHash: tx }, errorCount: 1,
    lastError: { message: 'crossout-ux: Bitcoin fees are high right now (400 sat/vB, about 134000 sats for this step), so it is waiting for them to fall under 100', at: T0 } }, T0);
  assert.deepEqual(held.acts.map((a) => a.kind), ['force']);
  assert.match(held.note, /^Bitcoin fees are high right now \(400 sat\/vB, about 134000 sats for this step\)/, 'the engine\'s words, its prefix dropped: the press shows what it will cost');
  assert.doesNotMatch(held.note, /crossout-ux/);
  const tried = outRow({ id: 'y', stage: 'mint-signed', source: { value: big(5) }, errorCount: 4, lastError: { message: 'bad-txns-inputs-missingorspent' } }, T0);
  assert.match(tried.note, /^bad-txns-inputs-missingorspent \(4 tries\)\. Bitcoin has not taken the signed transaction\. Signing again uses a coin that is free now/);
  const old = outRow({ id: 'z', stage: 'settling', createdAt: T0 - 3 * 3600e3, source: { value: big(5) } }, T0);
  assert.match(old.note, /^Cancelling looks for the burn on Ethereum once more first/);
  const inFee = inRow({ id: 'a:0', stage: 'traced', path: 'deposit', source: { amount: big(5) }, feeWait: { rate: 31.25, max: 20, at: T0 } }, T0, { burn: { maxRate: 20 } });
  assert.deepEqual(inFee.acts.map((a) => a.kind), ['burn'], 'with its burn held for the rate, it can still be pressed');
  assert.equal(inFee.note, 'Moved. The miner’s rate is 31.3 sat/vB, over the 20 sat/vB allowed (twice the rate quoted), so its burn waits for the rate to fall. Burn it sends it now at today’s rate.'.replace('31.3', (31.25).toFixed(1)));
  assert.equal(rowNote({ done: true, err: 'x' }), ''); assert.equal(rowNote({ dir: 'in', acts: [] }), '', 'nothing holds it: no note');
  // sending a rejected Bitcoin step again spends another fee, and the row says so (as the front page's does)
  const rej = outRow({ id: 'r', stage: 'mint-rejected', source: { value: big(5) }, settle: { claimIdVerified: true }, attempts: [1] }, T0);
  assert.deepEqual(rej.acts.map((a) => a.kind), ['retry']);
  assert.match(rej.note, /It can be sent again; that costs another Bitcoin fee\./);
  assert.doesNotMatch(outRow({ id: 'r2', stage: 'mint-rejected', source: { value: big(5) }, settle: { claimIdVerified: true }, attempts: [1, 2] }, T0).note, /another Bitcoin fee/, 'a step that is not offered again does not promise it');
  // ids
  const bad = outRow({ id: 'q', stage: 'settled', source: { value: big(5) }, settle: { txHash: 'x"><a href=//evil>' }, creditedTxid: '"onmouseover=alert(1)' }, T0);
  assert.equal(bad.ethTx, null); assert.equal(bad.btcTx, null, 'a transaction id that is not 64 hex digits is dropped');
  const ok = inRow({ id: 'w:0', stage: 'minted', source: { amount: big(1) }, burn: { txid: tx.toUpperCase() }, mintedTxHash: '0x' + tx }, T0);
  assert.equal(ok.btcTx, tx); assert.equal(ok.ethTx, '0x' + tx, 'a good id is lower case, and the Ethereum one has its 0x');
  // Recover: TAC only
  const lost = (assetId, extra = {}) => ({ id: 'l:0', stage: 'not-recorded', path: 'reflected', source: { assetId, amount: big(1) }, ...extra });
  assert.equal(inDue(lost('0x' + TAC_ID), T0), 'Recover'); assert.equal(inDue(lost('0x' + TETH_ID), T0), '', 'the service recovers no other asset');
  assert.equal(inRow(lost('0x' + TETH_ID), T0).acts.map((a) => a.kind).join(), 'recheck', 'a tETH burn that was not recorded can still be looked at again');
  // a move Bitcoin's proof has not reached, failing: its burn, and the way home
  const stall = inRow({ id: 's:0', stage: 'traced', path: 'deposit', source: { amount: big(1) }, errorCount: 3, lastError: { message: 'x' } }, T0);
  assert.deepEqual(stall.acts.map((a) => a.kind), ['burn', 'reclaim']); assert.equal(inRow({ id: 's:1', stage: 'traced', path: 'deposit', source: { amount: big(1) }, errorCount: 2, lastError: { message: 'x' } }, T0).acts.some((a) => a.kind === 'reclaim'), false);
});

test('a burn the proof passed without recording goes nowhere by itself, and says so; one moving back is not "Started"', () => {
  const stuck = inRow(inRec({ stage: 'not-recorded', source: { p2tr: true } }), NOW);
  assert.deepEqual(nextOf(stuck), { due: '', self: false });
  assert.match(stuck.note, /cannot be minted/);
  const recoverable = inRow(inRec({ stage: 'not-recorded' }), NOW);
  assert.equal(nextOf(recoverable).due, 'Recover');
  assert.doesNotMatch(recoverable.note, /cannot be minted/);
  assert.equal(inRow(inRec({ stage: 'recovering' }), NOW).moving, true);
  assert.equal(inRow(inRec({ stage: 'reclaim-sent' }), NOW).moving, true);
  assert.equal(inRow(inRec({ stage: 'burn-mined' }), NOW).moving, false);
});

test('the Bitcoin transaction a way in links to is the one the front page links: never a burn only signed, the move for a two-step bridge before its burn', () => {
  const tx = (c) => c.repeat(64), row = (stage, extra = {}) => inRow(inRec({ stage, ...extra }), NOW);
  assert.equal(row('rburn-signed', { burn: { txid: tx('b'), hex: '00' } }).btcTx, null, 'a burn that was only signed was never sent');
  assert.equal(row('rburn-sent', { burn: { txid: tx('b'), hex: '00' } }).btcTx, tx('b'));
  assert.equal(row('migrate-sent', { burn: undefined, migrate: { revealTxid: tx('c') } }).btcTx, tx('c'), 'a two-step bridge links its move before its burn');
  assert.equal(row('migrate-signed', { burn: undefined, migrate: { revealTxid: tx('c') } }).btcTx, null, 'and not before the move was sent');
  assert.equal(row('reclaim-sent', { reclaim: { txid: tx('d') } }).btcTx, tx('d'), 'a move back links its own transaction');
  assert.equal(row('recovered', { recover: { txid: tx('e') } }).btcTx, tx('e'), 'and a recovery its own');
  assert.equal(row('not-recorded', { burn: { txid: 'zz', hex: '00' } }).btcTx, null, 'an id that is not 64 hex digits is dropped');
});
