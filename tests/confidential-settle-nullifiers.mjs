#!/usr/bin/env node
// The swap / LP / route verifiers must report the nullifier the settle guest actually records for each spent
// input: native_nu = keccak(nk ‖ leaf ‖ "tacit-native-nullifier-v1") for an owned native note, the leaf-bound
// nullifier for an owner-0 bearer note. The swap and LP cases rebuild the committed fixture witnesses through the
// real builders and compare against the PublicValues of the committed real Groth16 proofs of those witnesses —
// the guest's own output, not a JS re-derivation.
//
// Run: node tests/confidential-settle-nullifiers.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialSwap } from '../dapp/confidential-swap.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';
import { makeConfidentialRoute } from '../dapp/confidential-route.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const ct = makeConfidentialTransfer({ keccak256 });
const swap = makeConfidentialSwap({ keccak256, pool });
const lp = makeConfidentialLp({ keccak256, pool, kernelSign: ct.kernelSign, rangeProve: ct.rangeProve });
const route = makeConfidentialRoute({ keccak256, pool, kernelSign: ct.kernelSign });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const lc = (x) => String(x).toLowerCase();

// Decode a bytes32[] field of an abi.encode((PublicValues)) blob: `nullifiers` is field 3, `lockNullifiers` 18.
function pvWords(hex, field) {
  const d = hex.replace(/^0x/, ''); const w = (o) => Number(BigInt('0x' + d.slice(o * 2, o * 2 + 64)));
  const base = w(0); const off = base + w(base + field * 32); const cnt = w(off);
  return Array.from({ length: cnt }, (_, i) => '0x' + d.slice((off + 32 + 32 * i) * 2, (off + 64 + 32 * i) * 2));
}
const pvNullifiers = (hex) => pvWords(hex, 3);
const g16 = (name) => JSON.parse(readFileSync(new URL(`../contracts/test/fixtures/${name}`, import.meta.url), 'utf8'));
const opFix = (name) => JSON.parse(readFileSync(new URL(`../contracts/sp1/confidential/fixtures/${name}`, import.meta.url), 'utf8'));

// ───────── 1. OP_SWAP: the swap_op.json witness, rebuilt through buildIntent/buildBatch ─────────
{
  const ASSET_A = '0x' + 'aa'.repeat(32), ASSET_B = '0x' + 'bb'.repeat(32);
  const IN_NK = '0x' + 'a1'.repeat(32);
  const det = (tag) => '0x' + Buffer.from(keccak256(new TextEncoder().encode('cswap-fixture-' + tag))).toString('hex');
  const intent = swap.buildIntent({
    direction: 'A->B', amountIn: 100, priceNum: 90, priceDen: 100, minOut: 90,
    rInSecp: BigInt(det('in-secp')), rOutSecp: BigInt(det('out-secp')),
    inNote: { owner: pool.nkToOwner(IN_NK), nk: IN_NK, leafIndex: 0, path: pool.zeros }, outOwner: '0x' + '00'.repeat(31) + '02',
    assetA: ASSET_A, assetB: ASSET_B,
  });
  const tree = new pool.Tree();
  const idx = tree.insert(pool.leaf(ASSET_A, intent.in.cx, intent.in.cy, intent.in.owner));
  intent.in.leafIndex = idx; intent.in.path = tree.rootAndPath(idx).path;
  const batch = swap.buildBatch({ assetA: ASSET_A, assetB: ASSET_B, chainBinding: '0x' + '11'.repeat(32), feeBps: 30, reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100, intents: [intent], spendRoot: tree.rootAndPath(0).root });
  const { nullifiers } = swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom });
  const pv = pvNullifiers(g16('swap_groth16.json').publicValues);
  assert.deepStrictEqual(nullifiers.map(lc), pv.map(lc), 'verifyBatch nullifiers == the proven swap PublicValues');
  assert.strictEqual(lc(intent.inNullifier), lc(pv[0]), 'buildIntent inNullifier == the proven nullifier');
  assert.deepStrictEqual(opFix('swap_op.json').expected.nullifiers.map(lc), pv.map(lc), 'swap_op.json expected.nullifiers == proven PV');
  ok('OP_SWAP: verifyBatch + buildIntent report the guest-recorded native_nu (== swap_groth16 PV)');
}

// ───────── 2. OP_LP_ADD: the lp_op.json witness, rebuilt through buildAdd ─────────
{
  const ASSET_A = '0x' + 'aa'.repeat(32), ASSET_B = '0x' + 'bb'.repeat(32);
  const A_NK = '0x' + 'a1'.repeat(32), B_NK = '0x' + 'b2'.repeat(32);
  const det = (tag) => BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('clp-fixture-' + tag))).toString('hex'));
  const op = lp.buildAdd({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: '0x' + '11'.repeat(32), feeBps: 30, protocolFeeBps: 0, protocolFeeRecipient: '0x' + '00'.repeat(33),
    reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
    aNote: { owner: pool.nkToOwner(A_NK), nk: A_NK, leafIndex: 0, path: pool.zeros }, dA: 100, rA: det('a-secp'),
    bNote: { owner: pool.nkToOwner(B_NK), nk: B_NK, leafIndex: 0, path: pool.zeros }, dB: 200, rB: det('b-secp'),
    shareOwner: '0x' + '00'.repeat(31) + '02', rShares: det('share-secp'),
  });
  const tree = new pool.Tree();
  const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
  const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
  op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
  op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
  const { nullifiers } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot: tree.rootAndPath(0).root });
  const pv = pvNullifiers(g16('lp_groth16.json').publicValues);
  assert.deepStrictEqual(nullifiers.map(lc), pv.map(lc), 'verifyAdd nullifiers == the proven LP PublicValues');
  for (const f of ['lp_op.json', 'lp_protofee_op.json']) {
    const g = f.replace('_op.json', '_groth16.json');
    assert.deepStrictEqual(opFix(f).expected.nullifiers.map(lc), pvNullifiers(g16(g).publicValues).map(lc), `${f} expected.nullifiers == proven PV`);
  }
  // swapbatch_groth16.json proves the OP_SWAP_BLIND witness (swapblind_op.json), not swapbatch_op.json.
  const blind = opFix('swapblind_op.json');
  const bpv = g16('swapbatch_groth16.json').publicValues.replace(/^0x/, '');
  const bw = (o) => BigInt('0x' + bpv.slice(o * 2, o * 2 + 64));
  const bbase = Number(bw(0)), bswaps = bbase + Number(bw(bbase + 13 * 32));
  assert.strictEqual(lc(blind.chainBinding), lc('0x' + bw(bbase + 32).toString(16).padStart(64, '0')), 'swapbatch_groth16 chainBinding == swapblind_op.json');
  assert.strictEqual(lc(blind.expected.poolId), lc('0x' + bw(bswaps + 32).toString(16).padStart(64, '0')), 'swapbatch_groth16 poolId == swapblind_op.json');
  assert.strictEqual(bw(bswaps + 128), BigInt(blind.expected.reserveAPost), 'swapbatch_groth16 reserveAPost == swapblind_op.json');
  assert.strictEqual(bw(bswaps + 160), BigInt(blind.expected.reserveBPost), 'swapbatch_groth16 reserveBPost == swapblind_op.json');
  ok('OP_LP_ADD: verifyAdd reports every input\'s guest-recorded native_nu (== lp_groth16 PV); lp/protofee fixtures agree, swapbatch_groth16 settles swapblind_op.json');
}

// ───────── 3. change leaves are reported in the guest's order ─────────
{
  const ASSET_A = '0x' + 'aa'.repeat(32), ASSET_B = '0x' + 'bb'.repeat(32);
  const A_NK = '0x' + '0a'.repeat(32), B_NK = '0x' + '0b'.repeat(32);
  const CH = '0x' + '00'.repeat(31) + '07';
  const op = lp.buildAdd({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: '0x' + '11'.repeat(32), feeBps: 30,
    reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
    aNote: { owner: pool.nkToOwner(A_NK), nk: A_NK, leafIndex: 0, path: pool.zeros }, dA: 100, rA: randomScalar(),
    bNote: { owner: pool.nkToOwner(B_NK), nk: B_NK, leafIndex: 0, path: pool.zeros }, dB: 200, rB: randomScalar(),
    shareOwner: CH, rShares: randomScalar(),
    aChange: [{ value: 10n, blinding: randomScalar(), owner: CH }], bChange: [{ value: 20n, blinding: randomScalar(), owner: CH }],
  });
  const tree = new pool.Tree();
  const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
  const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
  op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path; op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
  const { leaves } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot: tree.rootAndPath(0).root });
  assert.strictEqual(leaves.length, 3, 'share + A change + B change');
  assert.strictEqual(lc(leaves[1]), lc(pool.leaf(ASSET_A, op.aChange[0].cx, op.aChange[0].cy, CH)), 'A change leaf under asset A');
  assert.strictEqual(lc(leaves[2]), lc(pool.leaf(ASSET_B, op.bChange[0].cx, op.bChange[0].cy, CH)), 'B change leaf under asset B');
  ok('OP_LP_ADD: change leaves follow the share leaf, each under its own leg\'s asset');
}

// ───────── 4. OP_SWAP_ROUTE + the nk rules ─────────
{
  const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32);
  const NK = '0x' + 'c1'.repeat(32), OWNER = pool.nkToOwner(NK);
  const hops = [{ assetNext: B, feeBps: 30, reserveAPre: 1_000_000, reserveBPre: 1_000_000 }];
  const mk = (inNote) => {
    const op = route.buildRoute({ asset0: A, chainBinding: '0x' + '11'.repeat(32), inNote, amountIn: 1000, rIn: randomScalar(), hops, minOut: 0, outOwner: '0x' + '00'.repeat(31) + '02', rOut: randomScalar() });
    const tree = new pool.Tree();
    const i = tree.insert(pool.leaf(A, op.in.cx, op.in.cy, op.in.owner));
    op.in.leafIndex = i; op.in.path = tree.rootAndPath(i).path;
    return { op, spendRoot: tree.rootAndPath(0).root };
  };
  const good = mk({ owner: OWNER, secret: NK, leafIndex: 0, path: pool.zeros });
  const r = route.verifyRoute(good.op, { merkleRootFrom: pool.merkleRootFrom, spendRoot: good.spendRoot });
  assert.strictEqual(lc(r.nullifiers[0]), lc(pool.nativeNullifier(NK, pool.leaf(A, good.op.in.cx, good.op.in.cy, OWNER))), 'route: native_nu');
  assert.notStrictEqual(lc(r.nullifiers[0]), lc(pool.nullifier(good.op.in.cx)), 'route: not keccak(cx‖"spent")');

  const wrong = mk({ owner: OWNER, secret: '0x' + 'c2'.repeat(32), leafIndex: 0, path: pool.zeros });
  assert.throws(() => route.verifyRoute(wrong.op, { merkleRootFrom: pool.merkleRootFrom, spendRoot: wrong.spendRoot }), /nk does not commit/, 'a wrong nk is rejected, as the guest does');

  const bearer = mk({ owner: '0x' + '00'.repeat(32), leafIndex: 0, path: pool.zeros });
  const rb = route.verifyRoute(bearer.op, { merkleRootFrom: pool.merkleRootFrom, spendRoot: bearer.spendRoot });
  assert.strictEqual(lc(rb.nullifiers[0]), lc(pool.nullifier(pool.leaf(A, bearer.op.in.cx, bearer.op.in.cy, '0x' + '00'.repeat(32)))), 'bearer: leaf-bound nullifier');

  const unknown = mk({ owner: OWNER, leafIndex: 0, path: pool.zeros });
  const ru = route.verifyRoute(unknown.op, { merkleRootFrom: pool.merkleRootFrom, spendRoot: unknown.spendRoot });
  assert.strictEqual(ru.nullifiers[0], null, 'no nk supplied: no nullifier is invented');
  ok('OP_SWAP_ROUTE: native_nu with nk, leaf-bound for bearer, rejection on a wrong nk, null without nk');
}

// ───────── 5. other settle fixtures' `expected` blocks agree with the witness and the proven PV ─────────
{
  const { makeConfidentialStealth } = await import('../dapp/confidential-stealth.js');
  const { signSchnorr, SECP_N } = await import('../dapp/bulletproofs.js');
  const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer: ct });
  const m = opFix('mixed_op.json');
  const mixedNu = [...m.transfer.inputs.map((i) => pool.nativeNu(i.owner, i.secret, pool.leaf(m.transfer.asset, i.cx, i.cy, i.owner))),
    pool.nativeNu(m.unwrap.owner, m.unwrap.secret, pool.leaf(m.unwrap.asset, m.unwrap.cx, m.unwrap.cy, m.unwrap.owner))];
  assert.deepStrictEqual([...m.expected.transferNullifiers, m.expected.unwrapNullifier].map(lc), mixedNu.map(lc), 'mixed_op expected == native_nu of its inputs');
  assert.deepStrictEqual(mixedNu.map(lc), pvNullifiers(g16('mixed_groth16.json').publicValues).map(lc), 'mixed_op nullifiers == proven PV');
  for (const [file, g] of [['stealthclaim_op.json', 'stealthclaim_groth16.json'], ['stealthrefund_op.json', 'stealthrefund_groth16.json']]) {
    const f = opFix(file);
    const nu = pool.nullifier(stealth.stealthLockLeafBlind(f.asset, f.lCx, f.lCy, f.ownerPub, f.deadline, f.locker));
    assert.strictEqual(lc(f.expected.lockNullifier), lc(nu), `${file} expected.lockNullifier == nullifier(lock leaf)`);
    assert.deepStrictEqual(pvWords(g16(g).publicValues, 18).map(lc), [lc(nu)], `${file} lock nullifier == proven PV`);
  }
  assert.strictEqual(opFix('farm_harvest_op.json').expected.leaves, 1, 'farm harvest emits one leaf (the reward note)');
  ok('mixed / stealth claim / stealth refund / farm harvest fixture expectations match the guest');
}

console.log(`\nconfidential-settle-nullifiers: ${n} passed`);
