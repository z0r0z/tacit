#!/usr/bin/env node
// OP_BRIDGE_MINT client (dapp/confidential-bridge-mint.js): builds the relayed mint for a folded Bitcoin burn,
// with the relay fee carried in the minted note. Checks the op against the harness wire shape
// (contracts/sp1/confidential/harnesses/exec-bridgemint.rs), the guest's conservation rule
// v_burn == v_out + fee with a laddered fee, and the relay submission.
//
// Run: node tests/confidential-bridge-mint-op.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { randomScalar, bppRangeVerify, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import { makeRecoveryGuard } from '../dapp/confidential-recovery-guard.js';
import { makeConfidentialRelay } from '../dapp/confidential-relay.js';
import { makeConfidentialBridgeMint, feeIsQuantized, ladderFee, destValueFor, txidInternal } from '../dapp/confidential-bridge-mint.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const ct = makeConfidentialTransfer({ keccak256 });
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const memo = makeConfidentialMemo({ secp, sha256, keccak256 });
const bm = makeConfidentialBridgeMint({ pool, ct });

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const toPoint = (hex) => G.constructor.fromHex(String(hex).replace(/^0x/, '')); // the BP+ module's own curve instance
const hexBytes = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));

const ASSET = '0x' + 'a5'.repeat(32);
const CHAIN_BINDING = '0x' + '7c'.repeat(32);
const AUTH_KEY = '0x' + '00'.repeat(31) + 'b7';             // burned note's x-only Taproot key
const DEST_NK = '0x' + 'c5'.repeat(32);
const DEST_OWNER = pool.nkToOwner(DEST_NK);
const SPENT_TXID_DISPLAY = '33'.repeat(31) + '44';
const SPENT_TXID = txidInternal(SPENT_TXID_DISPLAY);
const SPENT_VOUT = 1;

// ── fee ladder parity with the guest's fee_is_quantized ──
{
  for (const f of [0n, 1n, 9n, 10n, 99n, 100n, 120n, 12000n, 990000n, 10n ** 18n]) assert.ok(feeIsQuantized(f), `${f} is on the ladder`);
  for (const f of [101n, 123n, 12001n, 999n, -1n]) assert.ok(!feeIsQuantized(f), `${f} is off the ladder`);
  assert.strictEqual(ladderFee(12345n), 13000n, 'ladder rounds up to two significant digits');
  assert.strictEqual(ladderFee(12000n), 12000n, 'on-ladder fee unchanged');
  assert.strictEqual(ladderFee(0n), 0n, 'zero stays zero');
  assert.ok(feeIsQuantized(ladderFee(987654321n)), 'laddered value is quantized');
  assert.strictEqual(destValueFor({ burnValue: 1_500_000n, fee: 12_000n }), 1_488_000n, 'destination = burned − fee');
  assert.strictEqual(destValueFor({ burnValue: 1_500_000n }), 1_500_000n, 'no fee = full value (self-mint)');
  assert.throws(() => destValueFor({ burnValue: 1_500_000n, fee: 12_345n }), /fee ladder/, 'off-ladder fee refused at burn time');
  assert.throws(() => destValueFor({ burnValue: 100n, fee: 100n }), /below the burned value/, 'fee cannot consume the whole note');
  assert.strictEqual(txidInternal('0x' + '00'.repeat(31) + 'ff'), '0xff' + '00'.repeat(31), 'display txid is byte-reversed');
  ok('fee ladder mirrors the guest; the destination value is the burned value net of the fee');
}

// A folded reflected state: the burned note sits in the Bitcoin note tree, and the reflection recorded
// burnId → destLeaf in the bridge-burn set (the burn envelope pinned destLeaf at burn time).
function reflectedState({ sourceClass, burnValue, fee }) {
  const burned = { value: burnValue, blinding: randomScalar(), owner: AUTH_KEY };
  const dest = { value: destValueFor({ burnValue, fee }), blinding: randomScalar(), owner: DEST_OWNER };
  const { cx, cy } = pool.commitXY(burned.value, burned.blinding);
  const srcLeaf = bm.sourceLeaf({ sourceClass, asset: ASSET, cx, cy, owner: AUTH_KEY, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, chainBinding: CHAIN_BINDING });
  const d = pool.commitXY(dest.value, dest.blinding);
  const destLeaf = pool.leaf(ASSET, d.cx, d.cy, DEST_OWNER);
  const burnId = pool.bridgeBurnId(sourceClass === 0 ? 2 : 1, SPENT_TXID, SPENT_VOUT, srcLeaf, CHAIN_BINDING);
  const notes = ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), srcLeaf, '0x' + '03'.repeat(32)];
  const burns = pool.makeUtxoAccumulator();
  burns.insert('0x' + '00'.repeat(31) + '07', '0x' + '00'.repeat(31) + '99'); // an unrelated earlier burn
  burns.insert(burnId, destLeaf);
  return { burned, dest, srcLeaf, destLeaf, burnId, snapshot: { noteLeaves: notes, burnNodes: burns.nodes() } };
}

// The keys exec-bridgemint.rs reads from the fixture, in stdin order.
const harness = readFileSync(join(ROOT, 'contracts/sp1/confidential/harnesses/exec-bridgemint.rs'), 'utf8');
const readsOf = (obj) => [...harness.matchAll(new RegExp(`\\b${obj}\\["([A-Za-z]+)"\\]`, 'g'))].map((m) => m[1]);
const HARNESS_KEYS = {
  f: [...new Set(readsOf('f'))], input: [...new Set(readsOf('inp'))], output: [...new Set(readsOf('out'))],
  burnMembership: [...new Set(readsOf('bm'))], kernel: [...new Set(readsOf('k'))],
};

// ── wire shape + conservation for a fee-carrying mint (bound reflected note, class 2) ──
const FEE = 12_000n, BURN = 1_500_000n;
const S = reflectedState({ sourceClass: 2, burnValue: BURN, fee: FEE });
const built = bm.buildBridgeMintOp({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S.burned, dest: S.dest, snapshot: S.snapshot });
{
  const { op } = built;
  assert.deepStrictEqual(HARNESS_KEYS.f.sort(), ['asset', 'bitcoinBurnRoot', 'burnMembership', 'chainBinding', 'fee', 'input', 'kernel', 'output', 'poolRoot', 'rangeProof', 'sourceClass', 'spentTxid', 'spentVout'].sort(), 'harness top-level reads (pinned)');
  for (const k of HARNESS_KEYS.f) assert.ok(k in op, `op carries ${k}`);
  for (const k of HARNESS_KEYS.input) assert.ok(k in op.input, `op.input carries ${k}`);
  for (const k of HARNESS_KEYS.output) assert.ok(k in op.output, `op.output carries ${k}`);
  for (const k of HARNESS_KEYS.burnMembership) assert.ok(k in op.burnMembership, `op.burnMembership carries ${k}`);
  for (const k of HARNESS_KEYS.kernel) assert.ok(k in op.kernel, `op.kernel carries ${k}`);
  const h32 = /^0x[0-9a-f]{64}$/;
  for (const v of [op.chainBinding, op.bitcoinBurnRoot, op.asset, op.poolRoot, op.spentTxid, op.input.cx, op.input.cy, op.input.owner, op.output.cx, op.output.cy, op.output.owner, op.burnMembership.next, op.kernel.z]) assert.match(v, h32);
  assert.match(op.kernel.R, /^0x0[23][0-9a-f]{64}$/, 'kernel R is a 33-byte compressed point');
  assert.ok(Number.isInteger(op.sourceClass) && Number.isInteger(op.spentVout) && Number.isInteger(op.input.leafIndex) && Number.isInteger(op.burnMembership.index), 'u32/u64 fields are JSON integers (as_u64)');
  assert.strictEqual(op.input.path.length, 32, 'depth-32 note-tree path');
  assert.strictEqual(op.burnMembership.path.length, 32, 'depth-32 burn-set path');
  // The harness reads fee as a u64 number or a decimal string.
  assert.match(String(op.fee), /^\d+$/);
  JSON.parse(JSON.stringify(op)); // plain JSON, no BigInt
  ok('op matches the exec-bridgemint.rs wire shape');
}
{
  const { op } = built;
  assert.strictEqual(BigInt(op.fee), FEE, 'fee field = the fee the burn left out of the destination');
  assert.strictEqual(BigInt(op.fee), BURN - S.dest.value, 'v_out + fee == v_burn');
  assert.strictEqual(built.fee, FEE);
  assert.ok(feeIsQuantized(BigInt(op.fee)), 'fee is on the ladder');
  const inC = [toPoint(pool.compressXY(op.input.cx, op.input.cy))];
  const outC = [toPoint(pool.compressXY(op.output.cx, op.output.cy))];
  const kernel = { R: toPoint(op.kernel.R), z: BigInt(op.kernel.z) };
  // verify_kernel_with_fee: the unbound transcript, default domain, public fee.
  assert.ok(ct.verifyKernel({ inC, outC, fee: FEE, kernel }), 'kernel verifies with the op fee');
  assert.ok(!ct.verifyKernel({ inC, outC, fee: 0n, kernel }), 'kernel fails with fee 0 (fee is bound)');
  assert.ok(!ct.verifyKernel({ inC, outC, fee: FEE + 1n, kernel }), 'kernel fails with a padded fee');
  assert.ok(!ct.verifyKernel({ inC, outC, fee: FEE, kernel, outLeaves: [built.destLeaf] }), 'the mint kernel is the unbound one (no leaf in the transcript)');
  assert.ok(bppRangeVerify(outC, hexBytes(op.rangeProof)), 'range proof over the destination commitment verifies');
  ok('conservation: kernel binds v_burn = v_out + fee; range proof covers the destination');
}
{
  const { op } = built;
  assert.strictEqual(op.sourceClass, 2, 'class detected from the reflected state');
  assert.strictEqual(op.input.owner, AUTH_KEY, 'class 2 input owner = Taproot key');
  const inLeaf = pool.btcNoteLeafBound(ASSET, op.input.cx, op.input.cy, op.input.owner, op.chainBinding);
  assert.ok(pool.verifyPath(inLeaf, op.input.leafIndex, op.input.path, op.poolRoot), 'burned note is a member of poolRoot');
  const burnId = pool.bridgeBurnId(1, op.spentTxid, op.spentVout, inLeaf, op.chainBinding);
  assert.strictEqual(burnId, S.burnId, 'guest rebuilds the same burnId');
  const destLeaf = pool.leaf(op.asset, op.output.cx, op.output.cy, op.output.owner);
  assert.strictEqual(destLeaf, S.destLeaf, 'dest leaf is the pinned destination');
  const bmLeaf = pool.utxoLeaf(burnId, op.burnMembership.next, destLeaf);
  assert.ok(pool.verifyPath(bmLeaf, op.burnMembership.index, op.burnMembership.path, op.bitcoinBurnRoot), 'burnId → destLeaf is a member of bitcoinBurnRoot');
  assert.strictEqual(built.nullifier, pool.nullifier(inLeaf), 'ν is leaf-bound');
  ok('memberships: burned note in the note tree, burnId → destLeaf in the burn set');
}

// ── other classes and the zero-fee (self-mint) case ──
{
  for (const cls of [1, 0]) {
    const s = reflectedState({ sourceClass: cls, burnValue: 777_000n, fee: cls === 1 ? 7_000n : 0n });
    const b = bm.buildBridgeMintOp({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: s.burned, dest: s.dest, snapshot: s.snapshot });
    assert.strictEqual(b.op.sourceClass, cls, `class ${cls} detected`);
    if (cls === 0) assert.strictEqual(b.op.input.owner, pool.outpointKey(SPENT_TXID, SPENT_VOUT), 'class 0 input owner = its outpoint key');
    assert.strictEqual(BigInt(b.op.fee), cls === 1 ? 7_000n : 0n);
    const inC = [toPoint(pool.compressXY(b.op.input.cx, b.op.input.cy))], outC = [toPoint(pool.compressXY(b.op.output.cx, b.op.output.cy))];
    assert.ok(ct.verifyKernel({ inC, outC, fee: BigInt(b.op.fee), kernel: { R: toPoint(b.op.kernel.R), z: BigInt(b.op.kernel.z) } }), `class ${cls} kernel verifies`);
  }
  ok('reflected (class 1) and burn-deposit (class 0) sources; fee 0 builds a self-mint');
}

// ── refusals ──
{
  const base = { chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S.burned, snapshot: S.snapshot };
  assert.throws(() => bm.buildBridgeMintOp({ ...base, dest: { ...S.dest, owner: '0x' + '11'.repeat(32) } }), /different destination/, 'a destination the burn did not commit to');
  assert.throws(() => bm.buildBridgeMintOp({ ...base, dest: { ...S.dest, value: S.dest.value - 5n } }), /fee ladder/, 'an off-ladder implied fee');
  assert.throws(() => bm.buildBridgeMintOp({ ...base, dest: { ...S.dest, value: S.dest.value - 1000n } }), /different destination/, 'a laddered fee the burn did not commit to');
  assert.throws(() => bm.buildBridgeMintOp({ ...base, dest: S.dest, sourceClass: 1 }), /not found/, 'wrong explicit class');
  assert.throws(() => bm.buildBridgeMintOp({ ...base, dest: S.dest, spentVout: 2 }), /not found/, 'wrong outpoint');
  assert.throws(() => bm.buildBridgeMintOp({ ...base, dest: S.dest, snapshot: { noteLeaves: S.snapshot.noteLeaves, burnNodes: [] } }), /not found/, 'burn not folded yet');
  assert.throws(() => bm.buildBridgeMintOp({ ...base, dest: { ...S.dest, value: BURN + 1n } }), /at most the burned value/, 'destination above the burn');
  ok('refuses a wrong destination, an off-ladder fee, a wrong class/outpoint and an unfolded burn');
}

// ── the Bitcoin-side envelope commits the fee'd destination the mint then reproduces ──
{
  const { parseBurnEnvelope } = await import('../dapp/burn-deposit-bitcoin.js');
  const burned = { value: 2_000_000n, blinding: randomScalar(), owner: AUTH_KEY };
  const e = bm.buildBridgeBurnEnvelope({ asset: ASSET, bitcoinPoolRoot: '0x' + '0d'.repeat(32), chainBinding: CHAIN_BINDING, burned, fee: 25_000n, dest: { blinding: randomScalar(), owner: DEST_OWNER } });
  assert.strictEqual((e.envelope.length - 2) / 2, 161, '161-byte envelope');
  const p = parseBurnEnvelope(e.envelope);
  assert.ok(p, 'parses as a 0x2B burn envelope');
  assert.strictEqual(p.asset.replace(/^0x/, ''), ASSET.slice(2), 'asset');
  assert.strictEqual(p.dest.replace(/^0x/, ''), e.destLeaf.slice(2), 'destination leaf');
  assert.strictEqual(p.target.replace(/^0x/, ''), CHAIN_BINDING.slice(2), 'target deployment');
  const { cx, cy } = pool.commitXY(burned.value, burned.blinding);
  assert.strictEqual(p.nullifier.replace(/^0x/, ''), pool.nullifier(pool.btcNoteLeafBound(ASSET, cx, cy, AUTH_KEY, CHAIN_BINDING)).slice(2), 'ν of the bound burned note (what fold_burn matches)');
  assert.strictEqual(e.dest.value, 1_975_000n, 'destination committed to v_burn − fee');
  assert.throws(() => bm.buildBridgeBurnEnvelope({ asset: ASSET, bitcoinPoolRoot: ASSET, chainBinding: CHAIN_BINDING, burned, fee: 25_001n, dest: { blinding: 1n, owner: DEST_OWNER } }), /fee ladder/);
  // Fold it (as the reflection would) and mint it.
  const srcLeaf = pool.btcNoteLeafBound(ASSET, cx, cy, AUTH_KEY, CHAIN_BINDING);
  const burns = pool.makeUtxoAccumulator();
  burns.insert(pool.bridgeBurnId(1, SPENT_TXID, SPENT_VOUT, srcLeaf, CHAIN_BINDING), p.dest.startsWith('0x') ? p.dest : '0x' + p.dest);
  const b = bm.buildBridgeMintOp({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned, dest: e.dest, snapshot: { noteLeaves: [srcLeaf], burnNodes: burns.nodes() } });
  assert.strictEqual(BigInt(b.op.fee), 25_000n, 'the mint carries the fee the burn left out');
  assert.strictEqual(b.nullifier, e.nullifier, 'same ν on both sides');
  ok('burn envelope pins the destination net of the fee; the mint reproduces it and carries the fee');
}

// ── relay submission: POST /confidential/submit {type: 'bridgemint'} with a recoverable memo ──
{
  const ownerPriv = randomScalar();
  const ownerPub = '0x' + Buffer.from(G.multiply(ownerPriv).toRawBytes(true)).toString('hex');
  const calls = [];
  const dump = { attestedHeight: 900000, snapshot: { height: 900000, ...S.snapshot } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/reflection/dump')) return new Response(JSON.stringify(dump), { status: 200 });
    if (String(url).endsWith('/confidential/submit')) return new Response(JSON.stringify({ ok: true, jobId: 'j1', status: 'settled', txHash: '0xabc' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const guard = makeRecoveryGuard({ memo });
  const relay = makeConfidentialRelay({ base: 'https://relay.test', fetchImpl, guard });
  const client = makeConfidentialBridgeMint({ pool, ct, relay, fetchImpl, relayBase: 'https://relay.test' });
  const r = await client.bridgeMint({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S.burned, dest: S.dest, recovery: { ownerPub, secret: DEST_NK } });
  assert.ok(calls[0].url.startsWith('https://relay.test/reflection/dump?network=mainnet'), 'reads the public reflected state');
  const submit = calls.find((c) => String(c.url).endsWith('/confidential/submit'));
  const body = JSON.parse(submit.init.body);
  assert.strictEqual(body.type, 'bridgemint');
  assert.strictEqual(BigInt(body.op.fee), FEE, 'submitted op carries the fee');
  assert.strictEqual(body.memos.length, 1, 'one memo for the one minted leaf');
  const opened = memo.openMemo(ownerPriv, r.destLeaf, body.memos[0]);
  assert.ok(opened && BigInt(opened.value) === S.dest.value && BigInt(opened.owner) === BigInt(DEST_OWNER), 'memo opens to the minted note');
  assert.strictEqual(r.status, 'settled');
  await assert.rejects(client.bridgeMint({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S.burned, dest: S.dest, snapshot: S.snapshot }), /recoverable/, 'a mint with no recovery channel is refused');
  const seedOnly = await client.bridgeMint({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S.burned, dest: S.dest, snapshot: S.snapshot, recovery: { seedDerived: true } });
  assert.strictEqual(seedOnly.status, 'settled', 'a seed-derived destination submits with an empty memo');
  ok('bridgeMint submits a fee-carrying bridgemint job with a recoverable memo');
}

console.log(`\n${n}/${n} confidential-bridge-mint-op checks passed`);
