// The cross-chain adaptor swap end to end, in both directions, with the real parts on each side:
//   Bitcoin  real commit/reveal transactions, validated by the dapp's own tacit.validateOutpoint
//   Ethereum the pinned settle guest (OP_ADAPTOR_LOCK / _CLAIM / _REFUND) run in execute mode, whose public values
//            are decoded the way a watcher decodes a settle (dapp/confidential-lock-scan.js)
// and nothing in between replaced by a test value: the Bitcoin locker's offer is checked from what the validator
// reads, the lock set is rebuilt from the guest's own lock leaves, the claim's z is read from its public values,
// and t from z opens the Bitcoin lock, whose spend the validator accepts.
//   HARNESS=contracts/sp1/confidential/harnesses/target/release node tests/fast-lane-e2e.test.mjs
// HARNESS is a directory holding exec-adaptor{lock,claim,refund} built from contracts/sp1/confidential/harnesses
// (they write the public values to PV_OUT). Without it the guest steps are skipped. Needs Node 22.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialAdaptor } from '../dapp/confidential-adaptor.js';
import { makeConfidentialLockScan } from '../dapp/confidential-lock-scan.js';
import { makeNoteResolver } from '../dapp/btc-pool-zap.js';
import * as adaptor from '../dapp/adaptor-signature.js';
import * as X from '../dapp/adaptor-xswap.js';
import { deriveLock } from '../dapp/adaptor-btc-lock.js';
import { G, SECP_N, pedersenCommit, bigintToBytes32, signSchnorr } from '../dapp/bulletproofs.js';
import { bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { P, fetched, tacit, scalar, xonly, p2trKey, keyPathSigner, fetchFrom, validate, cxfer, etchNote, NOTE_VALUE } from './lib/btc-sim.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp: rootSecp, keccak256: keccak_256, sha256 });
const ad = makeConfidentialAdaptor({ keccak256: keccak_256, secp: rootSecp, signSchnorr, curveOrder: SECP_N, pool });
const scan = makeConfidentialLockScan({ pool });

const te = (s) => new TextEncoder().encode(s);
const strip = (h) => String(h).replace(/^0x/, '');
const h0x = (b) => '0x' + bytesToHex(b);
const scalarHex = (x) => h0x(bigintToBytes32(x));
const xonlyHex = (d) => h0x(xonly(d));
const affineHex = (Pt) => { const u = Pt.toRawBytes(false); return { tx: h0x(u.slice(1, 33)), ty: h0x(u.slice(33, 65)) }; };
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

const HARNESS = process.env.HARNESS ? resolve(process.env.HARNESS) : null;
const haveGuest = !!HARNESS && ['exec-adaptorlock', 'exec-adaptorclaim', 'exec-adaptorrefund'].every((b) => existsSync(join(HARNESS, b)));
const dir = mkdtempSync(join(tmpdir(), 'fast-lane-e2e-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// One execute of the real guest. Accepted means public values were committed and nothing panicked (SP1 6.2's
// execute returns Ok on a guest panic and prints pv_bytes=0).
function runGuest(bin, op) {
  const tag = bin + '-' + Math.random().toString(36).slice(2);
  const opFile = join(dir, tag + '.json'), pvFile = join(dir, tag + '.pv');
  writeFileSync(opFile, JSON.stringify(op));
  const r = spawnSync(join(HARNESS, bin), [], { env: { ...process.env, MODE: 'execute', OP_FILE: opFile, PV_OUT: pvFile, RUST_LOG: 'error' }, encoding: 'utf8', timeout: 600_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const pvBytes = Number((out.match(/pv_bytes=(\d+)/) || [])[1] || 0);
  const ok = r.status === 0 && /EXECUTE_OK/.test(out) && pvBytes > 0 && !/panicked at/.test(out) && existsSync(pvFile);
  return { ok, out, pv: ok ? '0x' + readFileSync(pvFile, 'utf8').trim() : null };
}

// ── the actors: each is the Bitcoin locker in one direction and the Ethereum locker in the other ──
const CSV = 144, VALUE = 2500n, AMOUNT = VALUE, NOW = 1_800_000_000, DEADLINE = NOW + 3 * 3600;
const ASSET = '0x' + 'a1'.repeat(32); // TAC's pool asset id in a real run
const chainBinding = '0x' + '11'.repeat(32);
const actor = (name) => ({
  name, seed: sha256(te('seed/' + name)),
  dBtc: scalar(name + '/btc'),          // Bitcoin key: refund key as locker, claim key as claimer
  dAuth: scalar(name + '/evm-auth'),    // BIP-340 key a claim on Ethereum is signed with
  dRefund: scalar(name + '/evm-refund'),// key an Ethereum refund is signed with
  nk: scalarHex(scalar(name + '/nk')), nkOut: scalarHex(scalar(name + '/nk-out')),
});
const ACTORS = { user: actor('user'), lp: actor('lp') };

async function swap(direction) {
  const holder = direction === 'btc2eth' ? ACTORS.user : ACTORS.lp;   // Bitcoin locker, holds t, claims on Ethereum
  const counter = direction === 'btc2eth' ? ACTORS.lp : ACTORS.user;  // Ethereum locker, claims the Bitcoin lock
  const out = { direction, holder, counter };

  // Bitcoin: the holder's note, then the lock with its recovery hint, in one transfer.
  const holderSpk = p2trKey(xonly(holder.dBtc)), counterSpk = p2trKey(xonly(counter.dBtc));
  const r0 = scalar(direction + '/r0');
  const etch = etchNote({ ticker: 'TP', value: VALUE, r: r0, script: holderSpk, signerD: scalar(direction + '/etcher') });
  const noteIn = { txid: etch.txid, vout: 0, value: NOTE_VALUE, spk: holderSpk, sign: keyPathSigner(holder.dBtc), r: r0 };
  const swapId = X.swapIdOf(noteIn.txid, 0);
  const sec = X.deriveSwapSecrets({ seed: holder.seed, swapId });
  const rEvmLock = X.evmLockBlinding({ seed: counter.seed, swapId, T: sec.T });
  const counterPub = G.multiply(counter.dBtc).toRawBytes(true);
  const lock = deriveLock({ prims: P, claimerPub: counterPub, T: sec.T, lockerXonly: xonly(holder.dBtc), csvBlocks: CSV });
  const hint = X.lockHintScript({ seed: holder.seed, swapId, claimerPub: counterPub, csvBlocks: CSV, value: VALUE });
  const lockTx = cxfer(etch.asset, [noteIn], [{ value: VALUE, r: sec.rLock, script: lock.spk }], { extra: [{ value: 0, script: hint }] });
  Object.assign(out, { etch, noteIn, swapId, sec, rEvmLock, lock, lockTx });
  assert.equal(bytesToHex(X.swapIdFromLockTx(lockTx.esplora)), bytesToHex(swapId), 'the chain shows the swap id the holder derived from');

  // The Ethereum locker checks the Bitcoin lock from what the validator reads, not from what it was told.
  const fetchTx = fetchFrom(etch, lockTx);
  const resolveNote = makeNoteResolver({ validateOutpoint: (txid, vout, seen, f) => tacit.validateOutpoint(txid, vout, seen, f), txOutputEnvelope: tacit.txOutputEnvelope, getParentEnvelopeData: tacit.getParentEnvelopeData, fetchTx });
  const note = await resolveNote(lockTx.txid, 0);
  assert.ok(note, 'the validator accepts the lock output as a note');
  const offer = X.makeBtcLockOffer({
    swapId, asset: etch.asset, value: VALUE, rLock: sec.rLock, txid: lockTx.txid, vout: 0, csvBlocks: CSV, lockerXonly: xonly(holder.dBtc),
    T: sec.T, claimerPub: counterPub,
    evm: { asset: ASSET, amount: AMOUNT, recipient: xonlyHex(holder.dAuth), rOut: sec.rOut },
  });
  const chain = { spk: bytesToHex(lockTx.reveal.outputs[0].script), commitment: bytesToHex(note.commitment), validNote: true, confirmations: 1,
    noteInputs: lockTx.esplora.vin.slice(1).map((i) => ({ txid: i.txid, vout: i.vout })) };
  const seen = X.verifyBtcLockOffer(offer, { prims: P, myClaimerPub: counterPub, expect: { btcAsset: etch.asset, btcValue: VALUE, evmAsset: ASSET, evmAmount: AMOUNT }, chain, minConfs: 1 });
  assert.deepEqual(seen.reasons, [], 'the Bitcoin lock offer checks out');
  assert.equal(strip(note.assetIdHex).toLowerCase(), bytesToHex(etch.asset).toLowerCase(), 'the validator reads the offered asset from the chain');
  Object.assign(out, { offer, chain });
  return out;
}

// The Ethereum locker's side: its pool note, the OP_ADAPTOR_LOCK through the real guest, the lock set rebuilt from the
// guest's lock leaves, and the offer it sends back.
async function evmLock(s) {
  const { counter, holder, sec, rEvmLock } = s;
  const T = affineHex(sec.T);
  const rN = scalarHex(scalar(s.direction + '/rN'));
  const Nc = pool.commitXY(AMOUNT, rN);
  const nOwner = pool.nkToOwner(counter.nk);
  const nTree = new pool.Tree();
  const nIdx = nTree.insert(pool.leaf(ASSET, Nc.cx, Nc.cy, nOwner));
  const { root: spendRoot, path } = nTree.rootAndPath(nIdx);
  const nNote = { cx: Nc.cx, cy: Nc.cy, owner: nOwner, blinding: rN, leafIndex: nIdx, path, secret: counter.nk };
  const recipient = xonlyHex(holder.dAuth), refundPub = xonlyHex(counter.dRefund);
  const lockOp = ad.buildAdaptorLock({ chainBinding, spendRoot, asset: ASSET, nNote, amount: AMOUNT, lBlinding: scalarHex(rEvmLock), T, deadline: DEADLINE, recipient, refundPub });
  const res = runGuest('exec-adaptorlock', lockOp);
  assert.ok(res.ok, 'the guest accepts the lock: ' + res.out.slice(-300));
  const pv = scan.decodePublicValuesAdaptorFields(res.pv);
  assert.deepEqual(pv.lockLeaves, [lockOp.lockLeaf], 'the guest appends exactly the lock leaf the builder named');
  assert.equal(pv.nullifiers.length, 1, 'the locker\'s note is spent');
  assert.equal(pv.deadline, DEADLINE, 'the settle must land before the lock\'s own deadline');
  assert.equal(pv.lockNullifiers.length, 0);
  const lockTree = new pool.Tree();
  const lIdx = lockTree.insert(pv.lockLeaves[0]);
  const { root: lockSetRoot, path: lPath } = lockTree.rootAndPath(lIdx);
  assert.ok(pool.verifyPath(pv.lockLeaves[0], lIdx, lPath, lockSetRoot));
  const evmOffer = X.makeEvmOffer({ asset: ASSET, amount: AMOUNT, rEvmLock, T: sec.T, deadline: DEADLINE, recipient: strip(recipient), locker: strip(refundPub), rOut: sec.rOut });
  assert.equal(strip(evmOffer.lockLeaf), strip(pv.lockLeaves[0]), 'the offer names the leaf the guest appended');
  return { lockOp, lockPv: pv, lockSetRoot, lIdx, lPath, evmOffer, T, recipient, refundPub };
}

// The Bitcoin locker's side: it checks the offer, completes the kernel with t and claims through the real guest.
function evmClaim(s, e, { nowSecs = NOW } = {}) {
  const { holder, sec } = s;
  const v = X.verifyEvmOffer(e.evmOffer, { mine: { T: sec.T, recipient: strip(e.recipient), rOut: sec.rOut }, expect: { evmAsset: ASSET, evmAmount: AMOUNT }, inLockSet: e.lockPv.lockLeaves.map(strip).includes(strip(e.evmOffer.lockLeaf)), nowSecs });
  assert.deepEqual(v.reasons, [], 'the Ethereum offer checks out');
  const kernel = X.completeEvmClaim({ offer: e.evmOffer, t: sec.t, rOut: sec.rOut, nowSecs });
  const claimOp = ad.buildAdaptorClaim({
    chainBinding, lockSetRoot: e.lockSetRoot, asset: ASSET, lCx: e.lockOp.lCx, lCy: e.lockOp.lCy, T: e.T, deadline: DEADLINE,
    recipient: e.recipient, locker: e.refundPub, lIndex: e.lIdx, lPath: e.lPath, amount: AMOUNT, oBlinding: scalarHex(sec.rOut),
    kernel, outOwner: pool.nkToOwner(holder.nkOut), recipientPriv: scalarHex(holder.dAuth),
  });
  const res = runGuest('exec-adaptorclaim', claimOp);
  return { claimOp, kernel, res, pv: res.ok ? scan.decodePublicValuesAdaptorFields(res.pv) : null };
}

for (const direction of ['btc2eth', 'eth2btc']) {
  test(`${direction}: the lock, the claim and t from the claim's public values open the Bitcoin lock`, async () => {
    if (!haveGuest) { console.log('     (skipped: set HARNESS)'); return; }
    const s = await swap(direction);
    const e = await evmLock(s);
    const c = evmClaim(s, e);
    assert.ok(c.res.ok, 'the guest accepts the claim: ' + c.res.out.slice(-300));
    assert.deepEqual(c.pv.lockNullifiers, [c.claimOp.lockNullifier], 'the claim spends exactly this lock once');
    assert.deepEqual(c.pv.adaptorClaimS, [word(BigInt(c.claimOp.kernelS))], 'z is committed in the public values');
    assert.deepEqual(c.pv.leaves, [c.claimOp.outLeaf], 'the claimer\'s note is the only leaf');
    assert.equal(c.pv.lockSetRoot, e.lockSetRoot);
    assert.equal(c.pv.deadline, DEADLINE, 'the claim must land before the lock\'s deadline');
    assert.equal(c.pv.refundNotBefore, 0);

    // The Ethereum locker, knowing only its own pre-signature, reads z from the settle and takes the Bitcoin leg.
    const { t, sk } = X.openBtcLock({ offer: e.evmOffer, z: c.pv.adaptorClaimS[0], dClaimer: bigintToBytes32(s.counter.dBtc), lock: s.lock });
    assert.equal(t, s.sec.t, 't comes out of the committed z');
    const lockIn = { txid: s.lockTx.txid, vout: 0, value: NOTE_VALUE, spk: s.lock.spk, r: s.sec.rLock, sign: keyPathSigner(sk) };
    const take = cxfer(s.etch.asset, [lockIn], [{ value: VALUE, r: scalar(direction + '/r-take'), script: p2trKey(xonly(s.counter.dBtc)) }]);
    const f = fetchFrom(s.etch, s.lockTx, take);
    assert.deepEqual(await validate(f, take.txid, 0), { ok: true, reason: undefined }, 'the validator accepts the spend of the lock as a note');
  });
}

test('a z from another swap does not open this lock', async () => {
  if (!haveGuest) return;
  const a = await swap('btc2eth'), b = await swap('eth2btc');
  const ea = await evmLock(a), eb = await evmLock(b);
  const cb = evmClaim(b, eb);
  assert.throws(() => X.openBtcLock({ offer: ea.evmOffer, z: cb.pv.adaptorClaimS[0], dClaimer: bigintToBytes32(a.counter.dBtc), lock: a.lock }), /does not open/);
});

test('refund: nobody claimed, the locker takes its note back after the deadline, and the same lock cannot also be claimed', async () => {
  if (!haveGuest) return;
  const s = await swap('btc2eth');
  const e = await evmLock(s);
  const c = evmClaim(s, e);
  const refundOp = ad.buildAdaptorRefund({
    chainBinding, lockSetRoot: e.lockSetRoot, asset: ASSET, lCx: e.lockOp.lCx, lCy: e.lockOp.lCy, T: e.T, deadline: DEADLINE,
    recipient: e.recipient, locker: e.refundPub, lockerPriv: scalarHex(s.counter.dRefund), lIndex: e.lIdx, lPath: e.lPath, amount: AMOUNT,
    lBlinding: scalarHex(s.rEvmLock), oBlinding: scalarHex(scalar('refund-out')), fee: 0n, refundOwner: pool.nkToOwner(s.counter.nkOut),
  });
  const r = runGuest('exec-adaptorrefund', refundOp);
  assert.ok(r.ok, 'the guest accepts the refund: ' + r.out.slice(-300));
  const pv = scan.decodePublicValuesAdaptorFields(r.pv);
  assert.equal(pv.refundNotBefore, DEADLINE, 'a refund settles only at or after the deadline');
  assert.deepEqual(pv.adaptorClaimS, [], 'a refund reveals nothing about t');
  assert.deepEqual(pv.lockNullifiers, c.pv.lockNullifiers, 'claim and refund spend the same lock nullifier, so the pool takes one of them');
  assert.equal(c.pv.refundNotBefore, 0);
  assert.equal(c.pv.deadline, DEADLINE, 'and a claim cannot land after the deadline the refund opens at');
});

test('the Ethereum locker cannot make an offer for a lock holding less than the quote', async () => {
  const s = await swap('btc2eth');
  const { sec, rEvmLock } = s;
  const short = 2000n;
  const L = pedersenCommit(short, rEvmLock);
  const T = sec.T;
  const recipient = xonlyHex(s.holder.dAuth), refundPub = xonlyHex(s.counter.dRefund);
  const leaf = X.adaptorLockLeaf({ asset: ASSET, L, T, deadline: DEADLINE, recipient: strip(recipient), locker: strip(refundPub) });
  // The best a cheating locker can do: sign the kernel for the commitments it actually holds, with the quoted output.
  const O = pedersenCommit(AMOUNT, sec.rOut);
  const excess = (rEvmLock - sec.rOut + SECP_N) % SECP_N;
  const nonce = adaptor.evmKernelNonce({ excess, inC: [L], outC: [O], T });
  const pre = adaptor.evmKernelPresign({ excess, inC: [L], outC: [O], T, nonce });
  const offer = { v: 1, asset: strip(ASSET), amount: String(AMOUNT), L: bytesToHex(L.toRawBytes(true)), T: bytesToHex(T.toRawBytes(true)), deadline: DEADLINE,
    recipient: strip(recipient), locker: strip(refundPub), lockLeaf: bytesToHex(leaf), presign: { R: bytesToHex(pre.R.toRawBytes(true)), sTilde: bytesToHex(bigintToBytes32(pre.sTilde)) } };
  const v = X.verifyEvmOffer(offer, { mine: { T, recipient: strip(recipient), rOut: sec.rOut }, expect: { evmAsset: ASSET, evmAmount: AMOUNT }, inLockSet: true, nowSecs: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(';'), /pre-signature does not verify/);
});

test('timing: the default windows are consistent, and an Ethereum deadline too close to the refund opening is refused', () => {
  const tip = 800_000, lockHeight = 800_001;
  const opens = X.btcRefundOpensAt({ lockHeight, csvBlocks: CSV, tipHeight: tip, nowSecs: NOW });
  assert.deepEqual(X.checkEvmDeadline({ deadline: NOW + 3 * 3600, nowSecs: NOW, btcRefundOpens: opens }), []);
  assert.ok(X.checkEvmDeadline({ deadline: NOW + 23 * 3600, nowSecs: NOW, btcRefundOpens: opens }).length > 0, 'the Bitcoin refund would open before the locker could see z and claim');
  assert.ok(X.checkEvmDeadline({ deadline: NOW + 600, nowSecs: NOW, btcRefundOpens: opens }).length > 0, 'too little time to claim on Ethereum');
  assert.throws(() => X.completeEvmClaim({ offer: { deadline: NOW + 600, presign: { R: '02' + '11'.repeat(32), sTilde: '00'.repeat(32) } }, t: 1n, rOut: 1n, nowSecs: NOW }), /too close to the deadline/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} fast-lane end-to-end checks passed${haveGuest ? ' (with the guest)' : ' (set HARNESS to also run the guest)'}`);
process.exit(process.exitCode || 0);
