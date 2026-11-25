import assert from 'node:assert/strict';
import * as rootSecp from '@noble/secp256k1';
import * as X from '../dapp/adaptor-xswap.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeQuoter } from '../dapp/fastbridge-provider.js';
import { makeReverseService } from '../dapp/fastbridge-reverse-provider.js';
import { makeReverseClient, makeReverseCounter } from '../dapp/fastbridge-reverse-client.js';
import { G, bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes, hmac, sha256 as dappSha256 } from '../dapp/vendor/tacit-deps.min.js';
import { lockMemoKey, sealLockMemo, openLockMemo } from '../dapp/fastbridge-evm.js';
import { exactReverseSale } from '../fastbridge-lp/lib/reverse-rebalance.mjs';
import { tacit, te, scalar, etchNote } from './lib/btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, partyKeys, pool, sha256, ASSET, ad, CHAIN_BINDING, derive, scalarHex } from './lib/chain-sim.mjs';
import { memStore } from './lib/fastbridge-world.mjs';
import { BASE_UNIT, forwardEthereumPayout, reverseEthereumProceeds } from './stuck-tac-harness/scenarios.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const B = 100n * BigInt(BASE_UNIT);
const E = 10040120361n;
const strip = (value) => String(value).replace(/^0x/, '').toLowerCase();
const hmacSha256 = (key, message) => hmac(dappSha256, key, message);

function makeAssetEvmParty({ evm, keys, clock, asset }) {
  const holdings = [];
  const party = { keys, holdings };
  party.fund = (amount, tag) => {
    const r = scalarHex(derive(keys.seed, `note/${tag}`));
    const commitment = pool.commitXY(amount, r), owner = pool.nkToOwner(keys.nk);
    const leaf = pool.leaf(asset, commitment.cx, commitment.cy, owner);
    const leafIndex = evm.addNote(leaf);
    holdings.push({ cx: commitment.cx, cy: commitment.cy, owner, blinding: r, nk: keys.nk, amount, leafIndex, leaf, used: false });
  };
  party.lockOp = async ({ rec, rEvmLock, T, deadline, recipient, refundXonly }) => {
    const amount = BigInt(rec.offer.evm.amount);
    const h = holdings.find((item) => !item.used && item.amount === amount);
    if (!h) return null;
    const { root, path } = evm.notes.rootAndPath(h.leafIndex);
    const aff = (point) => { const raw = point.toRawBytes(false); return { tx: `0x${bytesToHex(raw.slice(1, 33))}`, ty: `0x${bytesToHex(raw.slice(33, 65))}` }; };
    const op = ad.buildAdaptorLock({
      chainBinding: CHAIN_BINDING, spendRoot: root, asset,
      nNote: { cx: h.cx, cy: h.cy, owner: h.owner, blinding: h.blinding, leafIndex: h.leafIndex, path, secret: h.nk },
      amount, lBlinding: scalarHex(rEvmLock), T: aff(T), deadline, recipient: `0x${strip(recipient)}`, refundPub: `0x${bytesToHex(refundXonly)}`,
    });
    op.lockMemo = sealLockMemo({ hmacSha256, key: lockMemoKey({ hmacSha256, walletPriv: keys.seed }), swapId: rec.id, offer: rec.offer, deadline });
    h.used = true;
    return { op, lockLeaf: op.lockLeaf, lockNu: pool.nullifier(op.lockLeaf) };
  };
  party.findOwnLocks = async () => {
    const key = lockMemoKey({ hmacSha256, walletPriv: keys.seed }), out = [];
    evm.locks.leaves.forEach((leaf, index) => { const found = openLockMemo({ hmacSha256, key, memo: evm.lockMemos[index] }); if (found) out.push({ ...found, lockLeaf: `0x${bytesToHex(leaf)}` }); });
    return out;
  };
  party.refundOp = async ({ rec, position }) => {
    const { op } = rec.lock;
    const aff = { tx: op.tx, ty: op.ty };
    return ad.buildAdaptorRefund({
      chainBinding: CHAIN_BINDING, lockSetRoot: position.lockSetRoot, asset, lCx: op.lCx, lCy: op.lCy, T: aff, deadline: op.deadline,
      recipient: op.recipient, locker: op.refundPub, lockerPriv: scalarHex(keys.dRefund), lIndex: position.lIndex, lPath: position.lPath, amount: BigInt(op.amount),
      lBlinding: scalarHex(X.evmLockBlinding({ seed: keys.seed, swapId: hexToBytes(rec.id), T: rootSecp.ProjectivePoint.fromHex(strip(rec.offer.T)) })),
      oBlinding: scalarHex(derive(keys.seed, `refund-out/${rec.id}`)), fee: 0n, refundOwner: pool.nkToOwner(keys.nkRefund),
    });
  };
  party.available = async () => holdings.filter((item) => !item.used).reduce((total, item) => total + item.amount, 0n);
  party.refundKey = async () => ({ xonly: G.multiply(keys.dRefund).toRawBytes(true).slice(1) });
  party.recipient = async () => ({ xonly: G.multiply(keys.dAuth).toRawBytes(true).slice(1), priv: keys.dAuth });
  party.claimOp = async ({ rec, evmOffer, sec, position }) => {
    const kernel = X.completeEvmClaim({ offer: evmOffer, t: sec.t, rOut: sec.rOut, nowSecs: clock.now(), minClaimSecs: 1800 });
    const T = { tx: `0x${bytesToHex(sec.T.toRawBytes(false).slice(1, 33))}`, ty: `0x${bytesToHex(sec.T.toRawBytes(false).slice(33, 65))}` };
    const L = rootSecp.ProjectivePoint.fromHex(strip(evmOffer.L)).toRawBytes(false);
    return ad.buildAdaptorClaim({
      chainBinding: CHAIN_BINDING, lockSetRoot: position.lockSetRoot, asset, lCx: `0x${bytesToHex(L.slice(1, 33))}`, lCy: `0x${bytesToHex(L.slice(33, 65))}`, T,
      deadline: evmOffer.deadline, recipient: `0x${strip(evmOffer.recipient)}`, locker: `0x${strip(evmOffer.locker)}`, lIndex: position.lIndex, lPath: position.lPath,
      amount: BigInt(evmOffer.amount), oBlinding: scalarHex(sec.rOut), kernel, outOwner: pool.nkToOwner(keys.nkOut), recipientPriv: scalarHex(keys.dAuth),
    });
  };
  return party;
}

function reverseWorld() {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock), kit = tacitKit(tacit);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(`${name}/btc-wallet`)), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('stuck-parity-user'), lW = wallet('stuck-parity-lp'), uKeys = partyKeys('stuck-parity-user'), lKeys = partyKeys('stuck-parity-lp');
  const r = scalar('stuck-parity-note');
  const etch = etchNote({ ticker: 'TP', value: B, r, script: lW.prims.p2wpkhScript(lW.wallet.pub), signerD: scalar('stuck-parity-etcher') });
  const poolAsset = `0x${bytesToHex(etch.asset)}`;
  const uEvm = makeAssetEvmParty({ evm, keys: uKeys, clock, asset: poolAsset }), lEvm = makeAssetEvmParty({ evm, keys: lKeys, clock, asset: poolAsset });
  uEvm.fund(E, 'published-e');
  btc.addConfirmed(etch);
  const inventory = [{ txid: etch.txid, vout: 0, value: 546, amount: B, blinding: r }];
  let coinN = 0;
  const sats = () => [{ txid: bytesToHex(sha256(te(`stuck-parity-coin/${coinN++}`))), vout: 0, value: 200000 }];
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims, kit }), sats });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims, kit }), sats });
  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const lBlEvm = { now: evm.now, lockPosition: evm.lockPosition, recipient: lEvm.recipient, claimOp: lEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const uElEvm = { ...base, lockOp: uEvm.lockOp, refundOp: uEvm.refundOp, refundKey: uEvm.refundKey, available: uEvm.available };
  const stores = {};
  const mk = () => ({ swaps: stores.swaps ||= memStore(), quotes: stores.quotes ||= memStore(), offers: stores.offers ||= memStore(), evmOffers: stores.evmOffers ||= memStore() });
  const config = {
    csvBlocks: 96, evmWindowSecs: 4 * 3600, maxOpen: 2, maxLocked: null, minConfsFor: () => 1, refreshSecs: 0, minProceedsBps: 10000,
    quote: { btcAsset: bytesToHex(etch.asset), evmAsset: poolAsset, minAmount: BigInt(BASE_UNIT), maxAmount: 1000n * BigInt(BASE_UNIT), feeBps: 30, flatFee: 10000000n, validSecs: 600 },
  };
  const w = { clock, btc, evm, etch, poolAsset, uW, lW, uKeys, lKeys, uEvm, lEvm, uBtc, lBtc, inventory, stores, config };
  w.makeService = () => makeReverseService({
    seed: lKeys.seed, btc: lBtc, evm: lBlEvm, ...mk(), inventory: { notes: async () => inventory }, now: clock.now,
    log: () => {}, alert: () => {}, config,
  });
  w.service = w.makeService();
  w.call = async (method, path, body) => w.service.handle({ method, path, body });
  w.lp = makeReverseCounter(w.call);
  w.userQuotes = memStore();
  w.client = makeReverseClient({ lp: w.lp, btc: uBtc, evm: uElEvm, store: memStore(), quoteStore: w.userQuotes, seed: uKeys.seed, now: clock.now, policy: { startGraceSecs: 6 * 3600 } });
  let ticks = 0;
  w.step = async () => { await w.service.tick(); await w.client.pump(); evm.process(); };
  w.run = async (until, max = 2000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return;
      await w.step();
      clock.advance(60);
      ticks += 1;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error(`same-asset reverse swap did not finish: ${JSON.stringify(await w.userQuotes.list())}`);
  };
  w.lpSwap = async () => (await stores.swaps.list())[0];
  w.userSwap = async () => (await w.client.records())[0];
  return w;
}

test('actual makeQuoter returns the published forward y and stores an exact quote', async () => {
  const store = memStore();
  const quoteParams = {
    btcAsset: 'aa'.repeat(32), evmAsset: strip(ASSET), minAmount: 1n, maxAmount: 1000n * BigInt(BASE_UNIT),
    feeBps: 30, flatFee: 10000000n, rate: { num: 1n, den: 1n }, claimPub: '02' + '01'.repeat(32),
    csvBlocks: 96, evmWindowSecs: 14400, validSecs: 600, minConfsFor: () => 1, takeSats: async () => 777,
  };
  const quoter = makeQuoter({ store, now: () => 1000, params: quoteParams });
  const A = 100n * BigInt(BASE_UNIT);
  assert.equal(quoter.price(A).evmAmount, 9960000000n);
  assert.equal(quoter.price(A).evmAmount, BigInt(forwardEthereumPayout(Number(A))));
  const quote = await quoter.quote(A);
  assert.equal(quote.btcValue, String(A));
  assert.equal(quote.evmAmount, '9960000000');
  assert.equal(quote.takeSats, 777);
  assert.equal(quote.created, 1000);
  assert.equal((await quoter.get(quote.id)).evmAmount, quote.evmAmount);
});

test('actual reverse service and production exactReverseSale agree on E, adjacent rounding and the floor', () => {
  const w = reverseWorld();
  assert.equal(w.service.price(E).btcValue, B);
  assert.equal(w.service.price(E - 1n).btcValue, B - 1n);
  assert.equal(w.service.price(E + 1n).btcValue, B + 1n);
  const plateauE = 1000n * BigInt(BASE_UNIT), plateauB = 99690000000n;
  assert.equal(w.service.price(plateauE).btcValue, plateauB);
  assert.equal(w.service.price(plateauE - 1n).btcValue, plateauB);
  const terms = {
    minAmount: String(BigInt(BASE_UNIT)), maxAmount: String(1000n * BigInt(BASE_UNIT)),
    feeBps: 30, flatFee: '10000000', minProceedsBps: 10000,
  };
  const exact = exactReverseSale(terms, B);
  assert.equal(exact.evmAmount, E);
  assert.equal(exact.evmAmount, BigInt(reverseEthereumProceeds(Number(B))));
  assert.equal(exact.btcValue, B);
  assert.equal(exact.proceedsOk, true);
  w.config.minProceedsBps = 11000;
  assert.throws(() => w.service.price(E), /11000 bps minimum/);
});

test('actual same-asset full reverse service completes the published B/E swap and credits E to the provider pool', async () => {
  const w = reverseWorld();
  const quote = await w.client.quote(E);
  assert.equal(quote.evmAmount, E);
  assert.equal(quote.btcValue, B);
  assert.equal(quote.fee, E - B);
  const { swapId } = await w.client.start({ quote });
  assert.match(swapId, /^[0-9a-f]{72}$/);
  await w.run(async () => (await w.lpSwap())?.phase === 'done' && (await w.userSwap())?.phase === 'done');
  const provider = await w.lpSwap(), user = await w.userSwap();
  assert.equal(provider.amount, String(B));
  assert.equal(provider.evmAmount, String(E));
  assert.ok(user.takeTxid);
  assert.ok(await w.btc.resolveNote(user.takeTxid, 0));
  const sec = X.deriveSwapSecrets({ seed: w.lKeys.seed, swapId: hexToBytes(swapId) });
  const output = pool.commitXY(E, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.evm.notes.leaves.some((leaf) => bytesToHex(leaf) === strip(pool.leaf(w.poolAsset, output.cx, output.cy, pool.nkToOwner(w.lKeys.nkOut)))));
  assert.equal(w.evm.locks.leaves.length, 1);
  assert.deepEqual(w.evm.submitted.map((job) => job.type), ['adaptorlock', 'adaptorclaim']);
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.log(`  FAIL - ${name}\n${error.stack}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} stuck TAC production-parity suites passed`);
process.exit(process.exitCode || 0);
