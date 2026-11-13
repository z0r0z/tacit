// dapp/btc-borrow.js, a loan of cUSD against cBTC as every page builds it: the open arguments from a cBTC note, what is remembered once it is in,
// the loan's leaf, the repay arguments and what is forgotten after, and the next position key (chain, this browser, and the cap between them).
// The pool module is a stand-in that records what it is asked: its own maths is tested elsewhere.
//   node tests/btc-borrow.test.mjs
import assert from 'node:assert/strict';
import { makeLoans, exactNotes, bondGap, bondCall, ESCROW, lockPad, lockRate, loanHealth, borrowAt, SAFE_RATIOS, NEAR_FALL, NEAR_CLEAR, fallToLiq, fallText, liqPhrase, approaching, loanId } from '../dapp/btc-borrow.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { makeCbtcNoteRecovery } from '../dapp/cbtc-note-recovery.js';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const L = makeLoans({ sha256: null, hmac: null, secp: null, bytesToHex: null, hexToBytes: null, pubHex: () => 'pub1' });
const t = {
  pool: { nativeNu: (o, nk, leaf) => `nu(${o},${nk},${leaf})`, leaf: (a, cx, cy, o) => `leaf(${a},${cx},${cy},${o})` },
  deriveOutput: (priv, anchor, kind, i) => ({ blindingHex: `b(${priv},${anchor},${kind},${i})`, nk: `nk(${priv},${anchor},${kind},${i})` }),
  cdp: {
    debtAssetId: (c) => `0xUSD-${c}`, basketLeg: (a, v) => `${a}:${v}`, basketRoot: (legs) => `root[${legs.join(',')}]`,
    positionLeaf: (...a) => `pos(${a.map(String).join('|')})`, positionNullifier: (leaf) => `null(${leaf})`,
  },
  recoverCdpPositions: async () => t.recovered,
};

// ── opening against a note ──
const note = { asset: '0xCBTC', cx: '1', cy: '2', value: '5000000', blinding: 'bl', leafIndex: 7, path: ['p'], owner: 'own', secret: 'sec', root: '0xroot' };
const { leg, anchor, args } = L.openArgs(t, 'PRIV', { note, debtValue: 900n, controller: '0xC', rate: '0xrate', positionOwner: '0xOWNER' });
assert.deepEqual(leg, { asset: '0xCBTC', cx: '1', cy: '2', value: '5000000', blinding: 'bl', leafIndex: 7, path: ['p'], owner: 'own', nk: 'sec' }, 'the note as the collateral leg, its secret as the nk');
assert.equal(anchor, 'nu(own,sec,leaf(0xCBTC,1,2,own))', 'the debt anchor is the note\'s nullifier');
assert.deepEqual(args, { controller: '0xC', debtValue: 900n, rateSnapshot: '0xrate', fee: 0n, collateral: [leg], spendRoot: '0xroot', debtBlinding: `b(PRIV,${anchor},cdpDebt,0)`, positionOwner: '0xOWNER', debtNk: `nk(PRIV,${anchor},cdpDebt,0)` }, 'the openCdp arguments');

let added = null;
const ps = { add: async (priv, rec) => { added = [priv, rec]; }, remove: (f) => { ps.kept = ps.kept.filter((x) => !f(x)); }, list: () => ps.kept, kept: [] };
await L.opened(ps, 'PRIV', { controller: '0xC', debtValue: 900n, keyNonce: 3, positionOwner: '0xOWNER', rate: '0xrate', anchor, basket: [{ asset: '0xCBTC', value: '5000000' }], txHash: '0xtx' });
assert.deepEqual(added, ['PRIV', { controller: '0xC', debtValue: '900', nonce: '0x' + '0'.repeat(64), keyNonce: 3, positionOwner: '0xOWNER', rateSnapshot: '0xrate', debtAnchor: anchor, basket: [{ asset: '0xCBTC', value: '5000000' }], openedAt: '0xtx' }], 'what is remembered once it is in');
await L.opened({ add: async () => { throw new Error('quota'); } }, 'PRIV', { controller: '0xC', debtValue: 1n, keyNonce: 0, positionOwner: 'o', rate: 'r', anchor: 'a', basket: [] });   // a store that fails does not fail the loan

// ── repaying ──
const p = { controller: '0xC', debtValue: '900', rateSnapshot: '0xrate', positionOwner: '0xOWNER', basket: [{ asset: '0x02', value: '5' }, { asset: '0x01', value: '7' }] };
const pl = L.positionLeaf(t, p);
assert.deepEqual(pl.basket.map((l) => l.asset), ['0x01', '0x02'], 'the basket in asset order');
assert.equal(pl.debtAsset, '0xusd-0xc');
assert.equal(pl.leaf, `pos(0xC|0xusd-0xc|root[0x01:7,0x02:5]|900|0xrate|0xOWNER|0x${'0'.repeat(64)})`, 'the loan\'s leaf, its nonce zero when none is kept');
const tree = { root: '0xtree', pathFor: (i) => ({ path: [`path${i}`] }) };
const debt = { cx: 'a', cy: 'b', value: '900', blinding: 'x', leafIndex: 9, path: ['q'], owner: 'o2', secret: 's2', root: '0xspend' };
const ra = L.repayArgs(t, 'PRIV', { p, ownerPriv: 'OP', basket: pl.basket, tree, index: 4, picked: [debt] });
const nu = `null(${pl.leaf})`;
assert.deepEqual(ra, {
  controller: '0xC', debtValue: 900n, rateSnapshot: '0xrate', positionOwner: '0xOWNER', positionOwnerPriv: 'OP', basket: pl.basket, positionIndex: 4, positionPath: ['path4'],
  spendRoot: '0xspend', cdpPositionRoot: '0xtree', fee: 0n,
  releaseBlindings: [`b(PRIV,${nu},cdpRelease,0)`, `b(PRIV,${nu},cdpRelease,1)`], releaseNks: [`nk(PRIV,${nu},cdpRelease,0)`, `nk(PRIV,${nu},cdpRelease,1)`],
  debtNotes: [{ cx: 'a', cy: 'b', value: '900', blinding: 'x', leafIndex: 9, path: ['q'], owner: 'o2', nk: 's2' }],
}, 'the closeCdp arguments: the collateral comes back to keys from the loan\'s nullifier');
ps.kept = [{ controller: '0xC', positionOwner: '0xOWNER', debtValue: '900' }, { controller: '0xC', positionOwner: '0xOTHER', debtValue: '900' }];
L.repaid(ps, p);
assert.deepEqual(ps.kept, [{ controller: '0xC', positionOwner: '0xOTHER', debtValue: '900' }], 'only the repaid loan is forgotten');

// ── the next position key ──
const ownerOf = (i) => `owner${i}`, K = 'tacit-cdp-next-key-nonce:0xc:pub1';
ps.kept = [];
t.recovered = { nextKeyNonce: 4, skipped: [] };
assert.equal(await L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), 4, 'the chain\'s next');
assert.equal(mem.get(K), '5', 'and this browser moves past it');
assert.equal(await L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), 5, 'a key handed out here and not yet on chain is not handed out again');
mem.set(K, '40');
assert.equal(await L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), 14, 'never more than ten past the chain');
ps.kept = [{ controller: '0xc', keyNonce: 20, positionOwner: 'owner20' }]; mem.delete(K);
t.recovered = { nextKeyNonce: 2, skipped: ['x'] };
assert.equal(await L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), 21, 'with a partial recovery, the most of it and the loans kept here');
ps.kept = []; mem.delete(K); t.recovered = null;
await assert.rejects(L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), /Could not read your existing loans/, 'nothing read and nothing kept: refused');
// ── the cUSD notes that repay a loan exactly ──
const nv = (...vs) => vs.map((v, i) => ({ id: i, value: String(v) }));
assert.deepEqual(exactNotes(nv(300, 500, 900), 500n).map((x) => x.value), ['500'], 'a note of exactly the loan');
assert.deepEqual(exactNotes(nv(100, 400, 250, 700), 500n).map((x) => x.value).sort(), ['100', '400'], 'else the fewest notes that add up to it');
assert.deepEqual(exactNotes(nv(100, 150, 200, 50), 500n)?.map((x) => x.value).sort(), ['100', '150', '200', '50'], 'up to four');
assert.equal(exactNotes(nv(100, 100, 100, 100, 100), 500n), null, 'never more than four');
assert.equal(exactNotes(nv(300, 400), 500n), null, 'no exact sum: left for a cut');
assert.equal(exactNotes(nv(200), 500n), null, 'too little');
// ── a lock's bond and mint ──
assert.deepEqual(bondGap(1000n, 0n), { want: 1100n, gap: 1100n }, 'the bond is the required escrow and a tenth more');
assert.deepEqual(bondGap(1000n, 400n), { want: 1100n, gap: 700n }, 'less what is posted');
assert.deepEqual(bondGap(1000n, 1200n), { want: 1100n, gap: 0n }, 'and nothing once it is covered');
const lockT = { pool: { outpointKey: (txid, vout) => `op(${txid},${vout})` } };
const lock = { lockTxid: '0102030405060708091011121314151617181920212223242526272829303132', lockVout: 1, vBtc: '5000000', anchor: { txid: 'ab'.repeat(32), vout: 0 } };
assert.deepEqual(bondCall(lockT, lock), { to: ESCROW, data: '0xc0e2d9a1' + `op(0x${lock.lockTxid.match(/../g).reverse().join('')},1)` }, 'postEscrowWithETH on the lock\'s outpoint, its txid in the pool\'s byte order');
const curveOrder = secp.CURVE?.n ?? secp.Point?.CURVE?.().n;
const LR = makeLoans({ sha256, hmac, secp: { CURVE: { n: curveOrder } }, pubHex: () => 'p', noteRecovery: async () => ({ makeCbtcNoteRecovery }) });
const priv = new Uint8Array(32).fill(7);
const ma = await LR.mintArgs(lockT, priv, lock);
const r0 = makeCbtcNoteRecovery({ hmac, sha256, curveOrder }), b0 = r0.deriveCbtcNoteBlinding({ privkey: priv, anchorOutpoint: r0.anchorBytes(lock.anchor.txid, lock.anchor.vout), outputIndex: 0 });   // the front page's former inline formula
assert.deepEqual(ma, { walletPriv: priv, outpoint: `op(0x${lock.lockTxid.match(/../g).reverse().join('')},1)`, vBtc: 5000000n, blinding: '0x' + b0.toString(16).padStart(64, '0') }, 'the mint\'s arguments, its blinding from the key and the anchor');
assert.notEqual((await LR.mintArgs(lockT, new Uint8Array(32).fill(8), lock)).blinding, ma.blinding, 'another key, another blinding');
// ── the key that closes a loan: derived from the Tacit key, else the copy this browser kept ──
{
  const kept = [{ controller: '0xC', positionOwner: '0xAbC', sec: 'sealed' }, { controller: '0xC', positionOwner: '0xother', sec: 'sealed-other' }];
  const ps2 = { list: () => kept, ownerPrivFor: async (priv, rec) => (rec.keyNonce === 3 ? `derived(${priv})` : rec.sec ? `opened(${rec.sec})` : null) };
  assert.equal(await L.ownerKey(ps2, 'PRIV', { controller: '0xC', positionOwner: '0xabc', keyNonce: 3 }), 'derived(PRIV)', 'derived from the key when the loan carries its nonce');
  assert.equal(await L.ownerKey(ps2, 'PRIV', { controller: '0xc', positionOwner: '0xABC' }), 'opened(sealed)', 'else the kept copy of the same loan, whatever the case of its hex');
  assert.equal(await L.ownerKey(ps2, 'PRIV', { controller: '0xC', positionOwner: '0xnobody' }), null, 'and nothing when neither has it');
}
// ── locking ──
// the pad: the reveal's dust output, its fee (212 vB) and the commit's fee for the coins it may spend (11 + 68 a coin + 74 vB), each fee at least 500 sats, and a tenth more
const padOf = (f, j, n = 2) => { const rate = Math.max(1, Math.ceil(f?.fastestFee || j?.['1'] || j?.['2'] || 5)), fee = (vb) => Math.max(500, vb * rate); return BigInt(Math.ceil((546 + fee(212) + fee(11 + n * 68 + 43 + 31)) * 1.1)); };
for (const [f, j] of [[null, null], [{ fastestFee: 3 }, null], [{ fastestFee: 40 }, null], [null, { 1: 12.4 }], [null, { 2: 7 }]]) {
  assert.equal(lockPad(f, j), padOf(f, j), `the pad for ${JSON.stringify([f, j])}`);
  for (const n of [1, 3, 6]) assert.equal(lockPad(f, j, n), padOf(f, j, n), `and for ${n} coin(s)`);
}
assert.equal(lockPad(null, null), 2983n, 'at the 5 sat/vB fallback: (546 dust + 1,060 + 1,105 in fees) and a tenth more');
assert.deepEqual([lockRate(null, null), lockRate({ fastestFee: 3 }, null), lockRate(null, { 1: 12.4 }), lockRate(null, { 2: 7 })], [5, 3, 13, 7], 'the rate the pad is sized at, which the lock is sent at');
const order = [];
const lockTL = { pool: { CBTC_ZK_ASSET_ID: '0xcbtc' }, syncCbtcLockReservations: async (priv) => { order.push(['sync', priv]); } };
const lockRes = { lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: 50000n, anchor: { txid: 'bb'.repeat(32), vout: 0 }, extra: 1 };
const LL = makeLoans({ pubHex: () => 'p',
  lockModule: async () => ({ makeCbtcLockMint: (o) => { order.push(['make', o.priv, o.cbtcAsset, o.hrp, o.excludeOutpoints.join()]); return { lock: async (a) => { order.push(['lock', String(a.amountSats)]); return lockRes; } }; } }),
  deployments: async () => ({ listProtectedOutpoints: () => ['p1:0'], protectOutpoint: (txid, vout, v) => order.push(['protect', txid, vout, String(v)]) }) });
const said = [];
const got = await LL.lock(lockTL, 'PRIV', { sats: 50000n, unconfirmed: ['u1:2'], say: (x) => said.push(x) });
assert.deepEqual(order, [['sync', 'PRIV'], ['make', 'PRIV', '0xcbtc', 'bc', 'p1:0,u1:2'], ['lock', '50000'], ['protect', 'aa'.repeat(32), 1, '50000']],
  'reservations read, then a lock maker that spends neither a lock nor an unconfirmed coin, then the lock, then its outpoint protected');
assert.equal(said.length, 2, 'and it says what it is doing');
assert.deepEqual({ ...got.record, at: 0 }, { lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '50000', anchor: { txid: 'bb'.repeat(32), vout: 0 }, at: 0 }, 'the record minting it needs');
// ── how safe a loan is ──
{
  const E = { usdBtc: 100000, floor: 150, liq: 130 };
  // 0.01 cBTC is worth $1,000 at $100,000
  const h = (debt, o = {}) => loanHealth({ sats: 1_000_000n, debt: BigInt(Math.round(debt * 1e8)), ...E, ...o });
  assert.deepEqual([h(400).ratio, h(400).level], [250, ''], '$1,000 against 400 cUSD is 250%, comfortable');
  assert.equal(h(500).ratio, 200); assert.equal(h(500).level, '');
  assert.equal(h(600).level, 'warn', 'under 175% it says so (166.7%)'); assert.ok(Math.abs(h(600).ratio - 166.666) < 0.01);
  assert.equal(h(700).level, 'err', 'under the 150% floor it is an error (142.9%)');
  assert.ok(Math.abs(h(500).liqAt - 65000) < 1e-6, '500 cUSD against 0.01 BTC is liquidated below $65,000 a bitcoin (500 / 0.01 x 1.30)');
  const none = { ratio: null, liqAt: null, fall: null, near: false, level: '' };
  assert.deepEqual(h(0), none); assert.deepEqual(h(5, { usdBtc: 0 }), none); assert.deepEqual(loanHealth({ sats: 0n, debt: 5n, ...E }), none);
  assert.equal(h(500, { liq: 0 }).liqAt, null, 'no liquidation ratio read: no price named');
  // how far bitcoin can fall: 0.01 cBTC against 500 cUSD is liquidated at $65,000, 35% under $100,000
  assert.ok(Math.abs(h(500).fall - 35) < 1e-9 && !h(500).near, '200% against a 130% line: bitcoin must fall 35%, not near');
  assert.equal(h(500, { liq: 0 }).fall, null); assert.equal(h(500, { liq: 0 }).near, false, 'no liquidation ratio read: nothing is near');
  assert.ok(h(695).near && !h(690).near, 'near is a fall of under 10% (143.9% is, 144.9% is not)');
  assert.ok(Math.abs(h(700).fall - 9) < 1e-9 && h(700).near && h(700).level === 'err', '142.9%: a 9% fall, near, an error');
  assert.equal(h(800).fall, 0, '125% is under the 130% line: it can be liquidated now'); assert.ok(h(800).near);
  assert.equal(fallToLiq(130, 130), 0); assert.equal(fallToLiq(131.3, 130) > 0, true); assert.equal(fallToLiq(null, 130), null); assert.equal(fallToLiq(150, 0), null);
  assert.equal(fallText(35), '35%'); assert.equal(fallText(12.99), '12%', 'rounded down, so the cushion is never overstated'); assert.equal(fallText(0.76), 'less than 1%');
  assert.equal(liqPhrase(h(500)), "liquidated below $65,000 a bitcoin, 35% under today's price");
  assert.equal(liqPhrase(h(763)), "liquidated below $99,190 a bitcoin, less than 1% under today's price", 'a loan a hair above the line says so');
  assert.equal(liqPhrase(h(800)), 'liquidated below $104,000 a bitcoin', 'already under the line: no distance to name');
  assert.equal(liqPhrase(h(500, { liq: 0 })), ''); assert.equal(liqPhrase(h(0)), ''); assert.equal(liqPhrase(null), '');
  // who is told: a loan newly near, once; kept while near and until it backs off 3 points more; told again if it returns
  {
    const L = (ratio, fall, debt = 500n) => ({ debt, sats: 1_000_000n, ratio, fall, near: fall != null && fall < NEAR_FALL });
    const far = L(200, 35), near = L(140, 7), mid = L(145, 10.3), back = L(150, 13.4);
    assert.deepEqual(approaching([far], []), { tell: [], keep: [] }, 'a safe loan: nothing');
    assert.deepEqual(approaching([near], []), { tell: [near], keep: [loanId(near)] }, 'newly near: told');
    assert.deepEqual(approaching([near], [loanId(near)]), { tell: [], keep: [loanId(near)] }, 'already told: not again');
    assert.deepEqual(approaching([mid], [loanId(mid)]), { tell: [], keep: [loanId(mid)] }, 'just above the line it hovers at: still remembered, so it does not repeat');
    assert.deepEqual(approaching([back], [loanId(back)]), { tell: [], keep: [] }, 'well clear again: forgotten');
    assert.deepEqual(approaching([L(140, 7)], []).tell.length, 1, 'and told afresh when it comes near again');
    assert.deepEqual(approaching([near, L(130, 0, 900n)], [loanId(near)]).tell.map(loanId), ['900:1000000'], 'a second loan is its own');
    assert.deepEqual(approaching([], [loanId(near)]), { tell: [], keep: [] }, 'a loan that is gone is forgotten');
    assert.equal(NEAR_CLEAR, 3);
  }
  // the amounts the chips fill: rounded down to the cent, so the loan lands at or above the ratio
  assert.deepEqual(SAFE_RATIOS, [250, 200, 175]);
  assert.equal(borrowAt({ sats: 1_000_000n, usdBtc: 100000, pct: 250 }), 400); assert.equal(borrowAt({ sats: 1_000_000n, usdBtc: 100000, pct: 200 }), 500);
  assert.equal(borrowAt({ sats: 1_000_000n, usdBtc: 100000, pct: 175 }), 571.42, '571.428… rounded down');
  assert.equal(borrowAt({ sats: 1_000_000n, usdBtc: 100000, pct: 150 }), 666.66);
  for (const pct of [250, 200, 175, 150]) assert.ok(h(borrowAt({ sats: 1_000_000n, usdBtc: 100000, pct })).ratio >= pct, `at ${pct}% the amount filled keeps at least ${pct}%`);
  assert.equal(borrowAt({ sats: 0n, usdBtc: 100000, pct: 200 }), 0); assert.equal(borrowAt({ sats: 5n, usdBtc: NaN, pct: 200 }), 0);
}
console.log('btc-borrow: all checks passed');
