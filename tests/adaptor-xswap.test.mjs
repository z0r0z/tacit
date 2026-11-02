// The cross-chain adaptor swap protocol (dapp/adaptor-xswap.js): known answers against the box-proven
// OP_ADAPTOR_CLAIM fixture, both directions end to end at the message level, the recovery hint, the windows,
// and each check's refusal. Pure: no chain, no network.
//   node tests/adaptor-xswap.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { secp, sha256, keccak_256, concatBytes, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { G, SECP_N, modN, pedersenCommit, bigintToBytes32, signSchnorr, verifySchnorr } from '../dapp/bulletproofs.js';
import * as adaptor from '../dapp/adaptor-signature.js';
import { claimSecret, deriveLock } from '../dapp/adaptor-btc-lock.js';
import * as X from '../dapp/adaptor-xswap.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const te = (s) => new TextEncoder().encode(s);
const hex = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '');
const pad64 = (h) => strip(h).padStart(64, '0');
const dOf = (tag) => (BigInt('0x' + hex(sha256(te('d/' + tag)))) % (SECP_N - 1n)) + 1n;
const xonly = (d) => G.multiply(d).toRawBytes(true).slice(1);
const pub33 = (d) => G.multiply(d).toRawBytes(true);
const { prims: P } = makeBtcWallet({
  priv: bigintToBytes32(5n), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1,
});

// ── known answers ──
const fx = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/adaptor_claim_op.json', import.meta.url), 'utf8'));

test('KAT: the JS lock leaf reproduces the box-proven claim fixture\'s lock-set root', () => {
  const leaf = X.adaptorLockLeafRaw({
    asset: pad64(fx.asset), lx: pad64(fx.lCx), ly: pad64(fx.lCy), tx: pad64(fx.tx), ty: pad64(fx.ty),
    deadline: fx.deadline, recipient: pad64(fx.recipient), locker: pad64(fx.locker),
  });
  let h = leaf;
  for (let i = 0; i < 32; i++) h = keccak_256(concatBytes(h, new Uint8Array(32)));
  assert.equal(hex(h), pad64(fx.lockSetRoot));
});

test('KAT: the library\'s claim-kernel challenge verifies the fixture\'s kernel (z*G == R + e*(L - O))', () => {
  const pt = (x, y) => secp.ProjectivePoint.fromHex('04' + pad64(x) + pad64(y));
  const L = pt(fx.lCx, fx.lCy), O = pt(fx.oCx, fx.oCy), R = secp.ProjectivePoint.fromHex(strip(fx.kernelR));
  const e = adaptor.evmKernelChallenge([L], [O], R);
  assert.ok(G.multiply(BigInt('0x' + strip(fx.kernelS))).equals(R.add(L.add(O.negate()).multiply(e))));
});

// ── the two parties ──
const party = (name) => ({ name, seed: sha256(te('seed/' + name)), dBtc: dOf(name + '/btc'), dAuth: dOf(name + '/auth'), dRefund: dOf(name + '/refund') });
const user = party('user'), lp = party('lp');
const QUOTE = { btcAsset: 'a1'.repeat(32), btcValue: 1000n, evmAsset: 'e1'.repeat(32), evmAmount: 5000n };
const NOW = 1_800_000_000, CSV = 144, LOCK_HEIGHT = 900_000;
const NOTE_TXID = 'c0'.repeat(32);

// Steps 1-4 with `btcLocker` holding t. Returns everything so tests can tamper with any step.
function run({ btcLocker, evmLocker, quote = QUOTE, nowSecs = NOW, deadline = NOW + 3 * 3600 }) {
  const swapId = X.swapIdOf(NOTE_TXID, 0);
  const sec = X.deriveSwapSecrets({ seed: btcLocker.seed, swapId });
  // 1. the Bitcoin locker locks and sends its offer; `chain` is what the lock output shows once mined
  const lock = deriveLock({ prims: P, claimerPub: pub33(evmLocker.dBtc), T: sec.T, lockerXonly: xonly(btcLocker.dBtc), csvBlocks: CSV });
  const offer = X.makeBtcLockOffer({
    swapId, asset: quote.btcAsset, value: quote.btcValue, rLock: sec.rLock, txid: 'b1'.repeat(32), vout: 0,
    csvBlocks: CSV, lockerXonly: xonly(btcLocker.dBtc), T: sec.T, claimerPub: pub33(evmLocker.dBtc),
    evm: { asset: quote.evmAsset, amount: quote.evmAmount, recipient: xonly(btcLocker.dAuth), rOut: sec.rOut },
  });
  const chain = { spk: lock.spk, commitment: pedersenCommit(quote.btcValue, sec.rLock).toRawBytes(true), validNote: true, confirmations: 1, noteInputs: [{ txid: NOTE_TXID, vout: 0 }] };
  // 2. the Ethereum locker checks, then locks and pre-signs
  const btcCheck = X.verifyBtcLockOffer(offer, { prims: P, myClaimerPub: pub33(evmLocker.dBtc), expect: quote, chain });
  const opens = X.btcRefundOpensAt({ lockHeight: LOCK_HEIGHT, csvBlocks: CSV, tipHeight: LOCK_HEIGHT, nowSecs });
  const windowReasons = X.checkEvmDeadline({ deadline, nowSecs, btcRefundOpens: opens });
  const evmSec = { rEvmLock: X.evmLockBlinding({ seed: evmLocker.seed, swapId, T: secp.ProjectivePoint.fromHex(offer.T) }) };
  const evmOffer = X.makeEvmOffer({
    asset: offer.evm.asset, amount: offer.evm.amount, rEvmLock: evmSec.rEvmLock, T: secp.ProjectivePoint.fromHex(offer.T),
    deadline, recipient: offer.evm.recipient, locker: xonly(evmLocker.dRefund), rOut: offer.evm.rOut,
  });
  // 3. the Bitcoin locker checks and claims
  const mine = { T: sec.T, recipient: xonly(btcLocker.dAuth), rOut: sec.rOut };
  const evmCheck = X.verifyEvmOffer(evmOffer, { mine, expect: quote, inLockSet: true, nowSecs });
  const claim = X.completeEvmClaim({ offer: evmOffer, t: sec.t, rOut: sec.rOut, nowSecs });
  // 4. the Ethereum locker extracts t and opens the Bitcoin lock
  const opened = X.openBtcLock({ offer: evmOffer, z: claim.z, dClaimer: evmLocker.dBtc, lock: btcCheck.lock });
  return { swapId, sec, offer, chain, btcCheck, windowReasons, evmSec, evmOffer, mine, evmCheck, claim, opened, quote, nowSecs, deadline };
}

for (const [name, btcLocker, evmLocker] of [['BTC -> ETH: user locks Bitcoin, LP locks Ethereum', user, lp], ['ETH -> BTC: LP locks Bitcoin, user locks Ethereum', lp, user]]) {
  test(`end to end, ${name}`, () => {
    const r = run({ btcLocker, evmLocker });
    assert.deepEqual(r.btcCheck.reasons, [], 'the Ethereum locker accepts the Bitcoin lock');
    assert.deepEqual(r.windowReasons, [], 'windows fit');
    assert.deepEqual(r.evmCheck.reasons, [], 'the Bitcoin locker accepts the Ethereum lock');
    assert.equal(r.opened.t, r.sec.t, 'z published t');
    const msg = sha256(te('spend'));
    assert.ok(verifySchnorr(signSchnorr(msg, r.opened.sk), msg, r.btcCheck.lock.outputXonly), 'and t opens the Bitcoin lock');
  });
}

test('secrets derive again from the key and the swap id alone, and differ per swap and per key', () => {
  const a = X.deriveSwapSecrets({ seed: user.seed, swapId: X.swapIdOf(NOTE_TXID, 0) });
  const b = X.deriveSwapSecrets({ seed: user.seed, swapId: X.swapIdOf(NOTE_TXID, 0) });
  const c = X.deriveSwapSecrets({ seed: user.seed, swapId: X.swapIdOf(NOTE_TXID, 1) });
  const d = X.deriveSwapSecrets({ seed: lp.seed, swapId: X.swapIdOf(NOTE_TXID, 0) });
  assert.equal(a.t, b.t); assert.equal(a.rLock, b.rLock); assert.equal(a.rOut, b.rOut);
  assert.notEqual(a.t, c.t); assert.notEqual(a.t, d.t);
  assert.equal(new Set([a.t, a.rLock, a.rOut]).size, 3, 'distinct per purpose');
});

test('the Ethereum locker\'s blinding is its own per swap id and per adaptor point (T and -T included)', () => {
  const sid = X.swapIdOf(NOTE_TXID, 0), T1 = G.multiply(dOf('T1'));
  const base = X.evmLockBlinding({ seed: lp.seed, swapId: sid, T: T1 });
  assert.equal(base, X.evmLockBlinding({ seed: lp.seed, swapId: sid, T: T1 }), 'derives again');
  assert.notEqual(base, X.evmLockBlinding({ seed: lp.seed, swapId: sid, T: T1.negate() }), 'T and -T share an x coordinate and must not share L');
  assert.notEqual(base, X.evmLockBlinding({ seed: lp.seed, swapId: X.swapIdOf(NOTE_TXID, 1), T: T1 }));
  assert.notEqual(base, X.evmLockBlinding({ seed: user.seed, swapId: sid, T: T1 }));
});

test('the pre-signature nonce differs for T and -T over the same (L, O), and for the same (L, O, T) under another lock leaf', () => {
  const L = pedersenCommit(5000n, dOf('rL')), O = pedersenCommit(5000n, dOf('rO')), x = modN(dOf('rL') - dOf('rO'));
  const T = G.multiply(dOf('T1'));
  const n = (T_, context) => adaptor.evmKernelNonce({ excess: x, inC: [L], outC: [O], T: T_, context });
  assert.notEqual(n(T), n(T.negate()), 'the shared nonce of T and -T would leak the excess from two pre-signatures');
  assert.notEqual(n(T, new Uint8Array([1])), n(T, new Uint8Array([2])));
  const a = adaptor.evmKernelPresign({ excess: x, inC: [L], outC: [O], T, nonce: n(T) });
  const b = adaptor.evmKernelPresign({ excess: x, inC: [L], outC: [O], T: T.negate(), nonce: n(T.negate()) });
  assert.notEqual(a.R.toHex(true), b.R.toHex(true), 'different nonce points, so no linear relation between the two s~ values');
});

test('the swap id is the outpoint the lock transaction spends: an offer that names another one is refused', () => {
  const r = run({ btcLocker: user, evmLocker: lp });
  assert.deepEqual(r.btcCheck.reasons, []);
  const forged = { ...r.offer, swapId: Array.from(X.swapIdOf('d0'.repeat(32), 0)).map((b) => b.toString(16).padStart(2, '0')).join('') };
  const v = X.verifyBtcLockOffer(forged, { prims: P, myClaimerPub: pub33(lp.dBtc), expect: QUOTE, chain: r.chain });
  assert.match(v.reasons.join(';'), /swap id is not the outpoint/);
  const unread = X.verifyBtcLockOffer(r.offer, { prims: P, myClaimerPub: pub33(lp.dBtc), expect: QUOTE, chain: { ...r.chain, noteInputs: undefined } });
  assert.match(unread.reasons.join(';'), /note inputs were not read/);
  assert.equal(hex(X.swapIdFromLockTx({ vin: [{ txid: 'ee'.repeat(32), vout: 0 }, { txid: NOTE_TXID, vout: 0 }] })), hex(r.swapId));
});

test('offers with fields that do not parse are refused with reasons and never throw', () => {
  const r = run({ btcLocker: user, evmLocker: lp });
  for (const [name, f] of [
    ['rOut not hex', (o) => ({ ...o, evm: { ...o.evm, rOut: 'not-hex' } })],
    ['value not a number', (o) => ({ ...o, btc: { ...o.btc, value: 'abc' } })],
    ['swap id short', (o) => ({ ...o, swapId: '00' })],
    ['no btc section', (o) => ({ ...o, btc: undefined })],
  ]) {
    const v = X.verifyBtcLockOffer(f(JSON.parse(JSON.stringify(r.offer))), { prims: P, myClaimerPub: pub33(lp.dBtc), expect: QUOTE, chain: r.chain });
    assert.equal(v.ok, false, name);
    assert.match(v.reasons.join(';'), /malformed offer/, name);
  }
  const e = X.verifyEvmOffer({ ...r.evmOffer, amount: 'abc' }, { mine: r.mine, expect: QUOTE, inLockSet: true, nowSecs: NOW });
  assert.equal(e.ok, false);
  assert.match(e.reasons.join(';'), /malformed offer/);
});

test('the recovery hint: the locker finds its lock and its opening from key + chain; nobody else does', () => {
  const r = run({ btcLocker: user, evmLocker: lp });
  const hint = X.lockHintScript({ seed: user.seed, swapId: r.swapId, claimerPub: pub33(lp.dBtc), csvBlocks: CSV, value: QUOTE.btcValue });
  assert.equal(hint.length, 49, 'OP_RETURN 47-byte push');
  const outputs = [{ script: r.btcCheck.lock.spk }, { script: hint }];
  const got = X.recoverBtcLock({ prims: P, seed: user.seed, swapId: r.swapId, lockerXonly: xonly(user.dBtc), outputs });
  assert.equal(got.vout, 0);
  assert.equal(got.value, QUOTE.btcValue);
  assert.equal(got.csvBlocks, CSV);
  assert.equal(got.rLock, r.sec.rLock, 'the opening needed to sign the refund kernel');
  assert.equal(hex(got.lock.leaf), hex(r.btcCheck.lock.leaf), 'and the refund leaf + control block');
  assert.equal(X.recoverBtcLock({ prims: P, seed: lp.seed, swapId: r.swapId, lockerXonly: xonly(user.dBtc), outputs }), null, 'another key reads nothing');
  assert.equal(X.recoverBtcLock({ prims: P, seed: user.seed, swapId: X.swapIdOf(NOTE_TXID, 7), lockerXonly: xonly(user.dBtc), outputs }), null, 'another swap id reads nothing');
  assert.equal(X.readLockHint({ seed: user.seed, swapId: r.swapId, script: r.btcCheck.lock.spk }), null, 'a non-hint output');
});

test('windows: the Bitcoin refund must open well after the Ethereum deadline, and the claimer needs time', () => {
  const opens = (csv, tip = LOCK_HEIGHT) => X.btcRefundOpensAt({ lockHeight: LOCK_HEIGHT, csvBlocks: csv, tipHeight: tip, nowSecs: NOW });
  assert.equal(opens(144), NOW + 143 * 300, '143 more blocks, assumed 5 min each');
  assert.equal(opens(2, LOCK_HEIGHT + 1), NOW, 'the next block can carry the refund');
  assert.deepEqual(X.checkEvmDeadline({ deadline: NOW + 3 * 3600, nowSecs: NOW, btcRefundOpens: opens(144) }), []);
  assert.match(X.checkEvmDeadline({ deadline: NOW + 3 * 3600, nowSecs: NOW, btcRefundOpens: opens(36) }).join(), /refunded too soon/);
  assert.match(X.checkEvmDeadline({ deadline: NOW + 600, nowSecs: NOW, btcRefundOpens: opens(144) }).join(), /too little time/);
});

// ── refusals: the Ethereum locker's check of the Bitcoin lock ──
test('the Bitcoin lock offer is refused on every mismatch', () => {
  const r = run({ btcLocker: user, evmLocker: lp });
  const check = (mutate, chainMutate = {}, opts = {}) => {
    const offer = structuredClone(r.offer);
    mutate(offer);
    return X.verifyBtcLockOffer(offer, { prims: P, myClaimerPub: pub33(lp.dBtc), expect: QUOTE, chain: { ...r.chain, ...chainMutate }, ...opts }).reasons.join(' | ');
  };
  assert.equal(check(() => {}), '');
  assert.match(check((o) => { o.claimerPub = hex(pub33(dOf('other'))); }), /not keyed to my claim key/);
  assert.match(check((o) => { o.btc.value = '999'; }), /differs from the quote/);
  assert.match(check((o) => { o.btc.rLock = hex(bigintToBytes32(dOf('r'))); }), /opening does not match/);
  assert.match(check((o) => { o.btc.csvBlocks = 12; }), /timelock under/);
  assert.match(check((o) => { o.T = hex(adaptor.adaptorPoint(dOf('t2')).toRawBytes(true)); }), /does not pay the lock/);
  assert.match(check((o) => { o.btc.lockerXonly = hex(xonly(dOf('stranger'))); }), /does not pay the lock/);
  assert.match(check((o) => { o.evm.amount = '4000'; }), /Ethereum side differs/);
  assert.match(check(() => {}, { validNote: false }), /not a valid note/);
  assert.match(check(() => {}, { confirmations: 0 }), /confirmation/);
  assert.match(check(() => {}, { confirmations: 2 }, { minConfs: 3 }), /fewer than 3/);
  let nonX = 1n; for (;;) { try { secp.ProjectivePoint.fromHex('02' + nonX.toString(16).padStart(64, '0')); nonX++; } catch { break; } }
  assert.match(check((o) => { o.evm.recipient = nonX.toString(16).padStart(64, '0'); }), /not an x-only key/);
});

// ── refusals: the Bitcoin locker's check of the Ethereum lock ──
test('the Ethereum offer is refused on every mismatch, including a locked note of a different amount', () => {
  const r = run({ btcLocker: user, evmLocker: lp });
  const check = (offer, opts = {}) => X.verifyEvmOffer(offer, { mine: r.mine, expect: QUOTE, inLockSet: true, nowSecs: NOW, ...opts }).reasons.join(' | ');
  const make = (o = {}) => X.makeEvmOffer({
    asset: QUOTE.evmAsset, amount: QUOTE.evmAmount, rEvmLock: r.evmSec.rEvmLock, T: r.sec.T, deadline: r.deadline,
    recipient: hex(xonly(user.dAuth)), locker: hex(xonly(lp.dRefund)), rOut: r.sec.rOut, ...o,
  });
  assert.equal(check(make()), '');
  assert.match(check(make({ T: adaptor.adaptorPoint(dOf('t2')) })), /not on my adaptor point/);
  assert.match(check(make({ recipient: hex(xonly(dOf('mallory'))) })), /does not pay my claim key/);
  assert.match(check(make(), { inLockSet: false }), /not in the pool/);
  assert.match(check({ ...make(), deadline: r.deadline + 86400 }), /do not make the stated lock leaf/);
  // The locker locks 4,999 but claims 5,000 in the offer: it cannot pre-sign over an L - O with an H component.
  const short = make({ amount: QUOTE.evmAmount - 1n });
  assert.match(check({ ...short, amount: String(QUOTE.evmAmount), lockLeaf: hex(X.adaptorLockLeaf({ asset: QUOTE.evmAsset, L: secp.ProjectivePoint.fromHex(short.L), T: r.sec.T, deadline: r.deadline, recipient: hex(xonly(user.dAuth)), locker: hex(xonly(lp.dRefund)) })) }), /pre-signature does not verify/);
  const bent = make(); bent.presign = { ...bent.presign, sTilde: hex(bigintToBytes32(BigInt('0x' + bent.presign.sTilde) + 1n)) };
  assert.match(check(bent), /pre-signature does not verify/);
  assert.match(check(make({ deadline: NOW + 600 })), /too little time/);
});

test('the claim refuses to publish z close to the deadline', () => {
  const r = run({ btcLocker: user, evmLocker: lp });
  assert.throws(() => X.completeEvmClaim({ offer: r.evmOffer, t: r.sec.t, rOut: r.sec.rOut, nowSecs: r.deadline - 600 }), /too close to the deadline/);
  assert.ok(X.completeEvmClaim({ offer: r.evmOffer, t: r.sec.t, rOut: r.sec.rOut, nowSecs: r.deadline - 3600 }).z);
});

test('a wrong z (another swap\'s claim) does not open the lock', () => {
  const r = run({ btcLocker: user, evmLocker: lp });
  assert.throws(() => X.openBtcLock({ offer: r.evmOffer, z: hex(bigintToBytes32(12345n)), dClaimer: lp.dBtc, lock: r.btcCheck.lock }), /does not open/);
  assert.throws(() => claimSecret({ dClaimer: user.dBtc, t: r.sec.t, lock: r.btcCheck.lock }), /does not open/, 'the right t is useless to anyone but the claimer');
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} adaptor-xswap checks passed`);
