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

// ── self-settle: the relay only proves, the caller sends settle() and pays its gas ──
{
  const dump = { attestedHeight: 900000, snapshot: { height: 900000, ...S.snapshot } };
  const submitted = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/reflection/dump')) return new Response(JSON.stringify(dump), { status: 200 });
    if (String(url).endsWith('/confidential/submit')) { submitted.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, jobId: 'jp1' }), { status: 200 }); }
    if (String(url).includes('/confidential/status')) return new Response(JSON.stringify({ jobId: 'jp1', mode: 'prove', status: 'proven', publicValues: '0x' + '0a'.repeat(32), proof: '0x' + '0b'.repeat(32) }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const relay = makeConfidentialRelay({ base: 'https://relay.test', fetchImpl, guard: makeRecoveryGuard({ memo }) });
  const client = makeConfidentialBridgeMint({ pool, ct, relay, fetchImpl, relayBase: 'https://relay.test' });
  const settles = [];
  const r = await client.bridgeMint({
    chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S.burned, dest: S.dest, snapshot: S.snapshot, recovery: { seedDerived: true },
    selfSettle: async (x) => { settles.push(x); return { txHash: '0x' + 'cc'.repeat(32) }; },
  });
  assert.strictEqual(submitted.length, 1);
  assert.strictEqual(submitted[0].mode, 'prove', 'the relay is asked to prove only');
  assert.strictEqual(submitted[0].type, 'bridgemint');
  assert.strictEqual(settles.length, 1, 'the caller settles once');
  assert.strictEqual(settles[0].publicValues, '0x' + '0a'.repeat(32));
  assert.strictEqual(settles[0].proof, '0x' + '0b'.repeat(32));
  assert.ok(Array.isArray(settles[0].memos), 'with the memos the proof commits to');
  assert.strictEqual(r.txHash, '0x' + 'cc'.repeat(32), 'the result carries the caller\'s transaction');
  assert.strictEqual(r.jobId, 'jp1');
  assert.strictEqual(r.destLeaf, client.buildBridgeMintOp({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S.burned, dest: S.dest, snapshot: S.snapshot }).destLeaf, 'and the mint it built');
  // A relay that cannot prove it: nothing is sent.
  const failing = async (url, init) => (String(url).includes('/confidential/status')
    ? new Response(JSON.stringify({ jobId: 'jp1', status: 'failed', error: 'prover down' }), { status: 200 }) : fetchImpl(url, init));
  const relay2 = makeConfidentialRelay({ base: 'https://relay.test', fetchImpl: failing, guard: makeRecoveryGuard({ memo }) });
  const client2 = makeConfidentialBridgeMint({ pool, ct, relay: relay2, fetchImpl: failing, relayBase: 'https://relay.test' });
  let sent = 0;
  await assert.rejects(client2.bridgeMint({
    chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S.burned, dest: S.dest, snapshot: S.snapshot, recovery: { seedDerived: true },
    selfSettle: async () => { sent++; return { txHash: '0x1' }; },
  }), /could not prove|prover down|failed/i);
  assert.strictEqual(sent, 0, 'a mint that could not be proved is never settled');
  ok('bridgeMint with selfSettle has the relay prove only, hands the proof to the caller, and never settles an unproved mint');
}

// ── a mint the relay turns back as built on an older burn set is built again from the newest state, then goes ──
{
  const S2 = reflectedState({ sourceClass: 2, burnValue: 1_500_000n, fee: 0n });
  const dumps = [];
  const fetchImpl = async (url) => { dumps.push(String(url)); return new Response(JSON.stringify({ snapshot: S2.snapshot, attestedHeight: 7 }), { status: 200 }); };
  const specs = [];
  const mk = (failures, code) => {
    let left = failures;
    return { settle: async (spec) => { specs.push(spec); if (left-- > 0) throw Object.assign(new Error('relay 409: moved on'), { code }); return { status: 'settled', jobId: 'j1', txHash: '0x' + 'ee'.repeat(32) }; } };
  };
  const args = { chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, burned: S2.burned, dest: S2.dest, recovery: { seedDerived: true }, staleDelayMs: 1 };
  const client = makeConfidentialBridgeMint({ pool, ct, relay: mk(1, 'stale_root'), fetchImpl, relayBase: 'https://relay.test' });
  const r = await client.bridgeMint({ ...args, snapshot: S2.snapshot });
  assert.strictEqual(r.status, 'settled');
  assert.strictEqual(specs.length, 2, 'the mint is submitted again once');
  assert.strictEqual(dumps.length, 1, 'from a newer state read for it (the first try used the one it was given)');
  assert.notStrictEqual(specs[0].op.kernel.z, specs[1].op.kernel.z, 'a new op, not the same bytes sent again');
  // Any other refusal, and a stale one that stays stale, is thrown rather than looped on.
  specs.length = 0;
  await assert.rejects(makeConfidentialBridgeMint({ pool, ct, relay: mk(1, 'free_budget'), fetchImpl, relayBase: 'https://relay.test' }).bridgeMint({ ...args, snapshot: S2.snapshot }), /moved on/);
  assert.strictEqual(specs.length, 1, 'another refusal is not retried');
  specs.length = 0;
  await assert.rejects(makeConfidentialBridgeMint({ pool, ct, relay: mk(9, 'stale_root'), fetchImpl, relayBase: 'https://relay.test' }).bridgeMint({ ...args, snapshot: S2.snapshot }), /moved on/);
  assert.strictEqual(specs.length, 3, 'a mint that stays stale is tried three times, then thrown');
  ok('a stale-root refusal rebuilds the mint from the newest state; any other refusal, and a mint that stays stale, is thrown');
}

// ── arming: the holder's half is handed to the relay at burn time, with the memo, and neither opening ──
{
  const ownerPriv = randomScalar();
  const ownerPub = '0x' + Buffer.from(G.multiply(ownerPriv).toRawBytes(true)).toString('hex');
  const calls = [];
  let armAnswer = { ok: true, status: 'armed' };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/confidential/arm?')) return new Response(JSON.stringify(armAnswer), { status: armAnswer.ok ? 200 : 400 });
    if (String(url).includes('/confidential/armed?')) return new Response(JSON.stringify({ ok: true, status: 'queued', jobId: '0x' + 'e1'.repeat(32) }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const relay = makeConfidentialRelay({ base: 'https://relay.test', fetchImpl, guard: makeRecoveryGuard({ memo }) });
  const client = makeConfidentialBridgeMint({ pool, ct, relay, fetchImpl, relayBase: 'https://relay.test' });
  const st = reflectedState({ sourceClass: 2, burnValue: BURN, fee: FEE });                      // the burn's openings (its state is not read)
  const args = { chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, sourceClass: 2, burned: st.burned, dest: st.dest, recovery: { ownerPub, secret: DEST_NK } };
  const r = await client.armMint(args);
  assert.deepStrictEqual({ ok: r.ok, status: r.status, dest: r.dest }, { ok: true, status: 'armed', dest: st.destLeaf });
  const post = calls.find((c) => c.url.includes('/confidential/arm?'));
  assert.strictEqual(post.init.method, 'POST');
  const body = JSON.parse(post.init.body);
  assert.strictEqual(body.type, 'bridgemint');
  assert.strictEqual(body.memos.length, 1);
  const opened = memo.openMemo(ownerPriv, st.destLeaf, body.memos[0]);
  assert.ok(opened && BigInt(opened.value) === st.dest.value, 'the memo opens to the minted note, for its holder');
  for (const k of ['bitcoinBurnRoot', 'poolRoot', 'burnMembership']) assert.ok(!(k in body.op), `${k} is read off the reflected state later, not sent`);
  assert.ok(!('path' in body.op.input) && !('leafIndex' in body.op.input));
  // Nothing posted opens either note.
  const wire = post.init.body.toLowerCase();
  for (const secret of [st.burned.blinding, st.dest.blinding, DEST_NK]) {
    assert.ok(!wire.includes(secret.toString(16).padStart(64, '0')) && !wire.includes(secret.toString()), 'a blinding or note secret is not in what is sent');
  }
  assert.deepStrictEqual(bm.verifyBridgeMintParts(body.op), { ok: true }, 'and what is sent stands on its own');
  // A seed-derived destination arms too (an empty memo list is refused only by the API, not here).
  assert.strictEqual((await client.armMint({ ...args, recovery: { seedDerived: true } })).ok, true);
  // A refusal comes back as a result with its code, not a throw.
  armAnswer = { ok: false, code: 'bad_proof', error: 'the range proof does not verify' };
  const no = await client.armMint(args);
  assert.deepStrictEqual({ ok: no.ok, code: no.code }, { ok: false, code: 'bad_proof' });
  await assert.rejects(client.armMint({ ...args, recovery: undefined }), /recoverable/);
  await assert.rejects(client.armMint({ ...args, sourceClass: undefined }), /unknown source class/, 'the class must be named: nothing is read to find it');
  const status = await client.armedStatus(st.destLeaf);
  assert.deepStrictEqual(status, { status: 'queued', jobId: '0x' + 'e1'.repeat(32) });
  assert.ok(calls.some((c) => c.url.includes(`/confidential/armed?dest=${st.destLeaf}`)));
  ok('armMint hands the relay the holder\'s half and its memo, with neither opening; armedStatus follows it');
}

console.log(`\n${n}/${n} confidential-bridge-mint-op checks passed`);
process.exit(0);   // a retry timer the last checks leave pending would otherwise keep the process alive for minutes
