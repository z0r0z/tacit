// The Ethereum leg's op witnesses (dapp/confidential-adaptor.js), built from a real swap flow
// (dapp/adaptor-xswap.js): OP_ADAPTOR_LOCK by the LP, OP_ADAPTOR_CLAIM by the user with the adaptor-completed
// kernel, and OP_ADAPTOR_REFUND by the LP for the path where nobody claims. Each witness is self-checked the way
// the guest checks it. With HARNESS=<dir holding exec-adaptor{lock,claim,refund}> (built from
// contracts/sp1/confidential/harnesses, embedding the pinned cxfer-guest ELF) each one also runs through the real
// guest in execute mode, together with two claims the guest must refuse.
//   node tests/adaptor-evm-ops.test.mjs
//   HARNESS=contracts/sp1/confidential/harnesses/target/release node tests/adaptor-evm-ops.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialAdaptor } from '../dapp/confidential-adaptor.js';
import { G, SECP_N, pedersenCommit, bigintToBytes32, signSchnorr, verifySchnorr } from '../dapp/bulletproofs.js';
import { secp } from '../dapp/vendor/tacit-deps.min.js';
import * as adaptor from '../dapp/adaptor-signature.js';
import * as X from '../dapp/adaptor-xswap.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp: rootSecp, keccak256: keccak_256, sha256 });
const ad = makeConfidentialAdaptor({ keccak256: keccak_256, secp: rootSecp, signSchnorr, curveOrder: SECP_N, pool });

const te = (s) => new TextEncoder().encode(s);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const h0x = (b) => '0x' + hex(b);
const strip = (h) => String(h).replace(/^0x/, '');
const dOf = (tag) => (BigInt('0x' + hex(sha256(te('d/' + tag)))) % (SECP_N - 1n)) + 1n;
const xonlyHex = (d) => h0x(G.multiply(d).toRawBytes(true).slice(1));
const scalarHex = (x) => h0x(bigintToBytes32(x));
const ZERO = '0x' + '00'.repeat(32);
const singleLeaf = (leafHex) => {
  let h = Uint8Array.from(strip(leafHex).match(/../g).map((x) => parseInt(x, 16)));
  for (let i = 0; i < 32; i++) h = keccak_256(new Uint8Array([...h, ...new Uint8Array(32)]));
  return { root: h0x(h), path: Array(32).fill(ZERO) };
};
const affineHex = (P) => { const u = P.toRawBytes(false); return { tx: h0x(u.slice(1, 33)), ty: h0x(u.slice(33, 65)) }; };

// ── one BTC -> ETH swap, Ethereum side ──
const chainBinding = '0x' + '11'.repeat(32);
const ASSET = '0x' + 'a1'.repeat(32); // TAC's pool id in a real run
const AMOUNT = 5000n, NOW = 1_800_000_000, DEADLINE = NOW + 3 * 3600;
const user = { seed: sha256(te('seed/user')), dAuth: dOf('user/auth'), nk: scalarHex(dOf('user/nk')) };
const lp = { seed: sha256(te('seed/lp')), dRefund: dOf('lp/refund'), nk: scalarHex(dOf('lp/nk')), nkRefund: scalarHex(dOf('lp/nk-refund')) };
const swapId = X.swapIdOf('c0'.repeat(32), 0);
const sec = X.deriveSwapSecrets({ seed: user.seed, swapId });        // the user holds t (it locked Bitcoin first)
const rEvmLock = X.evmLockBlinding({ seed: lp.seed, swapId, T: sec.T }); // the LP's locked-note blinding
const T = affineHex(sec.T);
const recipient = xonlyHex(user.dAuth), refundPub = xonlyHex(lp.dRefund);

// The LP's pool note N it locks: one leaf, in a one-leaf note tree.
const rN = scalarHex(dOf('lp/rN'));
const Nc = pool.commitXY(AMOUNT, rN);
const nOwner = pool.nkToOwner(lp.nk);
const nTree = singleLeaf(pool.leaf(ASSET, Nc.cx, Nc.cy, nOwner));
const nNote = { cx: Nc.cx, cy: Nc.cy, owner: nOwner, blinding: rN, leafIndex: 0, path: nTree.path, secret: lp.nk };

const lockOp = ad.buildAdaptorLock({ chainBinding, spendRoot: nTree.root, asset: ASSET, nNote, amount: AMOUNT,
  lBlinding: scalarHex(rEvmLock), T, deadline: DEADLINE, recipient, refundPub });
const lockTree = singleLeaf(lockOp.lockLeaf);

// The offer the LP sends, and the user's claim kernel (adaptor-xswap).
const evmOffer = X.makeEvmOffer({ asset: ASSET, amount: AMOUNT, rEvmLock: rEvmLock, T: sec.T, deadline: DEADLINE,
  recipient: strip(recipient), locker: strip(refundPub), rOut: sec.rOut });
const kernel = X.completeEvmClaim({ offer: evmOffer, t: sec.t, rOut: sec.rOut, nowSecs: NOW });
const claimOp = ad.buildAdaptorClaim({ chainBinding, lockSetRoot: lockTree.root, asset: ASSET, lCx: lockOp.lCx, lCy: lockOp.lCy, T,
  deadline: DEADLINE, recipient, locker: refundPub, lIndex: 0, lPath: lockTree.path, amount: AMOUNT, oBlinding: scalarHex(sec.rOut),
  kernel, outOwner: pool.nkToOwner(user.nk), recipientPriv: scalarHex(user.dAuth) });
const refundOp = ad.buildAdaptorRefund({ chainBinding, lockSetRoot: lockTree.root, asset: ASSET, lCx: lockOp.lCx, lCy: lockOp.lCy, T,
  deadline: DEADLINE, recipient, locker: refundPub, lockerPriv: scalarHex(lp.dRefund), lIndex: 0, lPath: lockTree.path, amount: AMOUNT,
  lBlinding: scalarHex(rEvmLock), oBlinding: scalarHex(dOf('lp/rRefundOut')), fee: 100n, refundOwner: pool.nkToOwner(lp.nkRefund) });

// ── self-checks, mirroring the guest's asserts ──
const ptXY = (cx, cy) => rootSecp.ProjectivePoint.fromHex('04' + strip(cx).padStart(64, '0') + strip(cy).padStart(64, '0'));

test('the pool commitment and the swap library\'s commitment are the same point', () => {
  const a = pool.commitXY(AMOUNT, scalarHex(rEvmLock));
  const b = pedersenCommit(AMOUNT, rEvmLock).toRawBytes(false);
  assert.equal(strip(a.cx).padStart(64, '0'), hex(b.slice(1, 33)));
  assert.equal(strip(a.cy).padStart(64, '0'), hex(b.slice(33, 65)));
});

test('lock: the leaf the LP proves is the one its offer names, and both openings verify', () => {
  assert.equal(strip(lockOp.lockLeaf), strip(evmOffer.lockLeaf), 'builder and offer agree on the lock leaf');
  const ctx = pool.intentContext('tacit-adaptor-lock-intent-v1', chainBinding, ASSET, ASSET,
    [[lockOp.nCx, lockOp.nCy, lockOp.locker], [lockOp.lCx, lockOp.lCy, recipient], [T.tx, T.ty, ZERO], [refundPub, ZERO, ZERO]], [AMOUNT, BigInt(DEADLINE)]);
  assert.ok(pool.verifyOpeningSigma(lockOp.nCx, lockOp.nCy, Number(AMOUNT), lockOp.nSigR, lockOp.nSigZ, ctx), 'N opening');
  assert.ok(pool.verifyOpeningSigma(lockOp.lCx, lockOp.lCy, Number(AMOUNT), lockOp.lSigR, lockOp.lSigZ, ctx), 'L opening');
  assert.ok(pool.verifyPath(pool.leaf(ASSET, lockOp.nCx, lockOp.nCy, lockOp.locker), 0, lockOp.nPath, lockOp.spendRoot), 'N membership');
});

test('claim: membership, O opening, the completed kernel, and the recipient signature all verify; z reveals t', () => {
  assert.ok(pool.verifyPath(claimOp.lockLeaf, 0, claimOp.lPath, claimOp.lockSetRoot));
  const oCtx = pool.intentContext('tacit-adaptor-claim-out-v1', chainBinding, ASSET, ASSET, [[claimOp.oCx, claimOp.oCy, recipient], [claimOp.lCx, claimOp.lCy, refundPub]], [AMOUNT, BigInt(DEADLINE)]);
  assert.ok(pool.verifyOpeningSigma(claimOp.oCx, claimOp.oCy, Number(AMOUNT), claimOp.oSigR, claimOp.oSigZ, oCtx));
  const L = ptXY(claimOp.lCx, claimOp.lCy), O = ptXY(claimOp.oCx, claimOp.oCy), R = rootSecp.ProjectivePoint.fromHex(strip(claimOp.kernelR));
  const e = BigInt('0x' + hex(keccak_256(new Uint8Array([...te('tacit-evm-cxfer-kernel-v1'), ...L.toRawBytes(true), ...O.toRawBytes(true), ...R.toRawBytes(true)])))) % SECP_N;
  assert.ok(rootSecp.ProjectivePoint.BASE.multiply(BigInt(claimOp.kernelS)).equals(R.add(L.add(O.negate()).multiply(e))), 'verify_kernel');
  const msg = ad.adaptorClaimMsg(chainBinding, claimOp.lockLeaf, claimOp.lockNullifier, claimOp.outLeaf, AMOUNT, claimOp.kernelR, claimOp.kernelS);
  assert.ok(verifySchnorr(Uint8Array.from(strip(claimOp.recipientSig).match(/../g).map((x) => parseInt(x, 16))), msg, Uint8Array.from(strip(recipient).match(/../g).map((x) => parseInt(x, 16)))));
  assert.equal(adaptor.evmKernelExtract(BigInt('0x' + evmOffer.presign.sTilde), BigInt(claimOp.kernelS)), sec.t, 'the LP reads t back out of the committed kernel s');
});

test('refund: membership, L opening, the fee kernel, and the locker signature verify', () => {
  const ctx = pool.intentContext('tacit-adaptor-refund-v1', chainBinding, ASSET, ASSET, [[refundOp.lCx, refundOp.lCy, refundPub], [refundOp.oCx, refundOp.oCy, refundPub]], [AMOUNT, BigInt(DEADLINE)]);
  assert.ok(pool.verifyOpeningSigma(refundOp.lCx, refundOp.lCy, Number(AMOUNT), refundOp.lSigR, refundOp.lSigZ, ctx));
  const L = ptXY(refundOp.lCx, refundOp.lCy), O = ptXY(refundOp.oCx, refundOp.oCy), R = rootSecp.ProjectivePoint.fromHex(strip(refundOp.kernelR));
  const e = BigInt('0x' + hex(keccak_256(new Uint8Array([...te('tacit-evm-cxfer-kernel-v1'), ...L.toRawBytes(true), ...O.toRawBytes(true), ...R.toRawBytes(true)])))) % SECP_N;
  const x = L.add(O.negate()).add(pool.prover.H.multiply(100n).negate());
  assert.ok(rootSecp.ProjectivePoint.BASE.multiply(BigInt(refundOp.kernelZ)).equals(R.add(x.multiply(e))), 'verify_kernel_with_fee');
  const msg = ad.adaptorRefundMsg(chainBinding, refundOp.lockLeaf, refundOp.oCx, refundOp.oCy, 100n, refundOp.refundOwner);
  assert.ok(verifySchnorr(Uint8Array.from(strip(refundOp.lockerSig).match(/../g).map((x) => parseInt(x, 16))), msg, Uint8Array.from(strip(refundPub).match(/../g).map((x) => parseInt(x, 16)))));
  assert.throws(() => ad.buildAdaptorRefund({ ...refundOp, T, lockerPriv: scalarHex(lp.dRefund), lBlinding: scalarHex(rEvmLock), oBlinding: scalarHex(1n), amount: AMOUNT, fee: AMOUNT }), /fee must be below/);
});

// ── the real guest, execute mode ──
const HARNESS = process.env.HARNESS ? resolve(process.env.HARNESS) : null;
if (HARNESS) {
  const dir = mkdtempSync(join(tmpdir(), 'adaptor-evm-'));
  const run = (bin, op) => {
    const file = join(dir, bin + '-' + Math.random().toString(36).slice(2) + '.json');
    writeFileSync(file, JSON.stringify(op));
    const r = spawnSync(join(HARNESS, bin), [], { env: { ...process.env, MODE: 'execute', OP_FILE: file, RUST_LOG: 'error' }, encoding: 'utf8', timeout: 600_000 });
    const out = (r.stdout || '') + (r.stderr || '');
    // SP1 6.2's execute returns Ok even when the guest panics: the harness still prints EXECUTE_OK, with
    // pv_bytes=0 and the panic on stderr. Accepted means public values were committed and nothing panicked.
    const pv = Number((out.match(/pv_bytes=(\d+)/) || [])[1] || 0);
    return { ok: r.status === 0 && /EXECUTE_OK/.test(out) && pv > 0 && !/panicked at/.test(out), out };
  };
  const panicOf = (out) => (out.match(/panicked[^\n]*\n?[^\n]*/) || out.match(/adaptor-[a-z]+:[^\n"]*/) || [''])[0].slice(0, 200);

  test('the deployed guest executes the LP\'s lock', () => {
    const r = run('exec-adaptorlock', lockOp);
    assert.ok(r.ok, panicOf(r.out) || r.out.slice(-400));
    console.log('     ' + (r.out.match(/EXECUTE_OK[^\n]*/) || [''])[0]);
  });
  test('the deployed guest executes the user\'s claim (the adaptor-completed kernel)', () => {
    const r = run('exec-adaptorclaim', claimOp);
    assert.ok(r.ok, panicOf(r.out) || r.out.slice(-400));
    console.log('     ' + (r.out.match(/EXECUTE_OK[^\n]*/) || [''])[0]);
  });
  test('the deployed guest executes the LP\'s refund', () => {
    const r = run('exec-adaptorrefund', refundOp);
    assert.ok(r.ok, panicOf(r.out) || r.out.slice(-400));
    console.log('     ' + (r.out.match(/EXECUTE_OK[^\n]*/) || [''])[0]);
  });
  test('the guest refuses a claim whose kernel was not completed with t', () => {
    const bad = ad.buildAdaptorClaim({ ...claimOp, T, kernel: { R: h0x(rootSecp.ProjectivePoint.fromHex(evmOffer.presign.R).add(rootSecp.ProjectivePoint.fromHex(evmOffer.T)).toRawBytes(true)), z: evmOffer.presign.sTilde },
      oBlinding: scalarHex(sec.rOut), amount: AMOUNT, recipientPriv: scalarHex(user.dAuth) });
    const r = run('exec-adaptorclaim', bad);
    assert.ok(!r.ok, 'executed: ' + r.out.slice(-700));
    assert.match(r.out, /value conservation/);
  });
  test('the guest refuses a claim signed by anyone but the recipient (the LP cannot claim its own lock)', () => {
    const bad = ad.buildAdaptorClaim({ ...claimOp, T, kernel, oBlinding: scalarHex(sec.rOut), amount: AMOUNT, recipientPriv: scalarHex(lp.dRefund) });
    const r = run('exec-adaptorclaim', bad);
    assert.ok(!r.ok, 'executed: ' + r.out.slice(-700));
    assert.match(r.out, /recipient BIP-340 authorization/);
  });
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}

let passed = 0;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const [name, fn] of tests) {
  if (ONLY && !ONLY.test(name)) continue;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} adaptor-evm-ops checks passed${HARNESS ? ' (with the guest)' : ' (set HARNESS to also run the guest)'}`);
