// OP_SWAP_BLIND (31) emitter parity test — arms the dormant guest op OFF the SP1 box by proving the
// emitted envelope against the JS mirrors of every guest check (the box re-runs the same math, so a
// mirror-accepted envelope is guest-accepted). Builds a 1-intent, tips=0, self-settle op and asserts:
//   (a) verifyXCurve accepts both 169-byte cross-curve sigmas (input + receipt);
//   (b) snarkjs.groth16.verify accepts the inner amm_swap_batch proof against swapBatchPublicSignals +
//       the ceremony vk (and the re-derived publics == the proof's own publicSignals);
//   (c) verifyOpeningPokBlind (mirror of verify_opening_pok_blind) accepts the blind intent PoK;
//   (d) the per-asset aggregate Pedersen identity holds (swapBatchAggregateIdentity, A and B);
//   (e) the assembled fixture's field order + byte lengths match the guest read order (exec-swapblind.rs
//       / main.rs:1665..1815), byte-counting each field.
// Plus forgery negatives: tamper each proof piece → the corresponding mirror rejects.
//
// Run: node tests/confidential-swapblind.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync as rf } from 'node:fs';
import assert from 'node:assert';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwapblind } from '../dapp/confidential-swapblind.js';
import { swapBatchGroth16Prove, swapBatchPublicSignals, parseGroth16Proof256, serializeGroth16Proof256 } from '../dapp/confidential-swapbatch.js';
import { verifyXCurve } from '../dapp/amm-sigma.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });

const hexToBytes = (h) => { h = String(h).replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ZERO33 = '0x' + '00'.repeat(33);
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const N = secp.CURVE.n;
const randScalar = () => { while (true) { const b = createHash('sha256').update(crypto.getRandomValues(new Uint8Array(32))).digest(); let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); if (x > 0n && x < N) return x; } };

// snarkjs fullProve / exportVerificationKey take file paths (or {type:'mem'}); pass paths so the
// 95MB zkey streams through fastfile rather than a hung in-memory Buffer.
const WASM = new URL('../dapp/vendor/amm_swap_batch.wasm', import.meta.url).pathname;
const ZKEY = new URL('../dapp/circuits/ceremony-genesis-amm/amm_swap_batch_0000.zkey', import.meta.url).pathname;

// ── batch parameters (canonical asset order; single A→B trader) ───────────────────────────────
const assetA = '0x' + '11'.repeat(32);
const assetB = '0x' + '22'.repeat(32);
const feeBps = 30;
const reserveAPre = 1_000_000n, reserveBPre = 1_000_000n;
const chainBinding = '0x' + 'ab'.repeat(32);
const amountIn = 1000n;

// the input note (a REAL spent pool note of asset A): commit(amountIn, rSecp), owner, membership branch.
const rInSecp = randScalar();
const inXY = pool.commitXY(amountIn, rInSecp);
const inNk = '0x' + '07'.repeat(32); const inOwner = pool.nkToOwner(inNk);
const inLeaf = pool.leaf(assetA, inXY.cx, inXY.cy, inOwner);
const { root: spendRoot, path: inPath } = (() => { const t = new pool.Tree(); t.insert(inLeaf); return t.rootAndPath(0); })();
assert(pool.verifyPath(inLeaf, 0, inPath, spendRoot), 'input leaf must be a member of spendRoot');

const outOwner = '0x' + '08'.repeat(32);
const rOutSecp = randScalar();

// injected prover — capture the re-derivable publicSignals for the (b) parity check.
let capturedPublics = null;
const proveGroth16 = async ({ input }) => {
  const { proofBytes, publicSignals } = await swapBatchGroth16Prove(input, WASM, ZKEY);
  capturedPublics = publicSignals;
  return proofBytes;
};
const ammDerivePoolIdV1 = (a, b, f) => pool.ammDerivePoolIdFull(a, b, f, 0, ZERO33, 0);

const emitter = makeConfidentialSwapblind({ pool, proveGroth16, ammDerivePoolIdV1 });

const { envelope, fixture } = await emitter.buildSwapBlindOp({
  chainBinding, assetA, assetB, feeBps, reserveAPre, reserveBPre, spendRoot,
  traders: [{
    direction: 0, amountIn, minOut: 0, deadline: 0,
    inNote: { cx: inXY.cx, cy: inXY.cy, owner: inOwner, rSecp: rInSecp, leafIndex: 0, path: inPath, nk: inNk },
    outOwner, rOutSecp,
  }],
});
ok('buildSwapBlindOp produced envelope + fixture');

const it0 = fixture.intents[0];
const inSigBytes = hexToBytes(it0.inXcurveSigma);
const outSigBytes = envelope.receipts[0].outXcurveSigma;
const cInSecp = envelope.intents[0].cInSecp, cInBjj = envelope.intents[0].cInBjj;
const cOutSecp = envelope.receipts[0].cOutSecp, cOutBjj = envelope.receipts[0].cOutBjj;

// ── (a) cross-curve sigmas ────────────────────────────────────────────────────────────────────
assert.strictEqual(inSigBytes.length, 169, 'input sigma is 169 bytes');
assert.strictEqual(outSigBytes.length, 169, 'receipt sigma is 169 bytes');
assert(verifyXCurve(inSigBytes, cInSecp, cInBjj), '(a) input xcurve sigma verifies');
assert(verifyXCurve(outSigBytes, cOutSecp, cOutBjj), '(a) receipt xcurve sigma verifies');
ok('(a) both 169-byte cross-curve sigmas accepted by verifyXCurve');

// forgery negatives — flip a byte in each sigma → reject.
{
  const t = inSigBytes.slice(); t[80] ^= 0xff;
  assert(!verifyXCurve(t, cInSecp, cInBjj), 'tampered input sigma rejected');
  const t2 = outSigBytes.slice(); t2[80] ^= 0xff;
  assert(!verifyXCurve(t2, cOutSecp, cOutBjj), 'tampered receipt sigma rejected');
  assert(!verifyXCurve(inSigBytes, cOutSecp, cInBjj), 'sigma bound to wrong C_secp rejected');
  ok('(a-neg) tampered/mis-bound sigmas rejected');
}

// ── (b) inner Groth16 vs swapBatchPublicSignals + ceremony vk ────────────────────────────────
const sjs = await import('snarkjs');
const groth16 = sjs.groth16 || (sjs.default && sjs.default.groth16);
const vkFromZkey = await (sjs.zKey || sjs.default.zKey).exportVerificationKey(ZKEY);
const bakedVk = JSON.parse(rf(new URL('../contracts/sp1/confidential/fixtures/swap_batch_vk.json', import.meta.url)));
const vkMatchesBaked = JSON.stringify(vkFromZkey.IC) === JSON.stringify(bakedVk.IC) && JSON.stringify(vkFromZkey.vk_delta_2) === JSON.stringify(bakedVk.vk_delta_2);
console.log('  info - ceremony 0000.zkey vk', vkMatchesBaked ? 'MATCHES' : 'DIFFERS FROM', 'the guest baked swap_batch_vk.json');

const circuitPoolId = ammDerivePoolIdV1(assetA, assetB, feeBps);
const pubEnv = {
  nIntents: envelope.nIntents,
  deltaANetSign: envelope.deltaANetSign, deltaANetMag: envelope.deltaANetMag,
  deltaBNetSign: envelope.deltaBNetSign, deltaBNetMag: envelope.deltaBNetMag,
  tipAAmount: 0, tipBAmount: 0, feeBps,
  intents: fixture.intents.map((it) => ({ direction: it.direction, cInBjj: it.cInBjj, minOut: it.minOut, tipAmount: 0 })),
  receipts: fixture.intents.map((it) => ({ cOutBjj: it.cOutBjj })),
};
const rederived = swapBatchPublicSignals(pubEnv, circuitPoolId, reserveAPre, reserveBPre);
assert(rederived, 'swapBatchPublicSignals derived 123 signals');
assert.strictEqual(rederived.length, 123, '123 public signals');
assert.deepStrictEqual(rederived.map((x) => BigInt(x).toString()), capturedPublics.map((x) => BigInt(x).toString()), 're-derived publics == the proof publicSignals');
const proofObj = parseGroth16Proof256(hexToBytes(envelope.proof));
assert(await groth16.verify(vkFromZkey, rederived.map((x) => BigInt(x).toString()), proofObj), '(b) proof verifies vs re-derived publics');
ok('(b) inner Groth16 accepted against swapBatchPublicSignals + ceremony vk (byte-format round-trips through the guest parser)');

// forgery negatives — tamper a public signal → reject; corrupt a proof limb → reject.
{
  const bad = rederived.slice(); bad[1] = (BigInt(bad[1]) + 1n);
  assert(!(await groth16.verify(vkFromZkey, bad.map((x) => BigInt(x).toString()), proofObj)), 'tampered public signal rejected');
  const bytes = hexToBytes(envelope.proof).slice(); bytes[0] ^= 0x01;
  let rej = true; try { rej = !(await groth16.verify(vkFromZkey, rederived.map((x) => BigInt(x).toString()), parseGroth16Proof256(bytes))); } catch { rej = true; }
  assert(rej, 'corrupted proof limb rejected');
  ok('(b-neg) tampered public / corrupted proof rejected');
}
// serialize↔parse round-trip is the identity (the guest parses exactly this layout).
assert.deepStrictEqual(serializeGroth16Proof256(proofObj), hexToBytes(envelope.proof), 'serialize(parse(bytes)) == bytes');
ok('(b) proof serialize/parse round-trip identity');

// ── (c) blind opening PoK (verify_opening_pok_blind mirror) ───────────────────────────────────
const ctx = pool.intentContext(
  'tacit-swap-blind-intent-v1', chainBinding, assetA, assetB,
  [[it0.inCx, it0.inCy, inOwner], [it0.outCx, it0.outCy, outOwner]],
  [0n, 0n, 0n], // [direction, minOut, deadline]
);
assert(pool.verifyOpeningPokBlind(it0.inCx, it0.inCy, it0.pokR, it0.pokZv, it0.pokZr, ctx), '(c) blind opening PoK verifies over the intent context');
ok('(c) verify_opening_pok_blind mirror accepts the PoK');

// forgery negatives — wrong context (redirect out_owner) → reject; tampered z → reject.
{
  const ctxBad = pool.intentContext('tacit-swap-blind-intent-v1', chainBinding, assetA, assetB,
    [[it0.inCx, it0.inCy, inOwner], [it0.outCx, it0.outCy, '0x' + '09'.repeat(32)]], [0n, 0n, 0n]);
  assert(!pool.verifyOpeningPokBlind(it0.inCx, it0.inCy, it0.pokR, it0.pokZv, it0.pokZr, ctxBad), 'redirected out_owner context rejected');
  const zBad = '0x' + (BigInt(it0.pokZv) ^ 1n).toString(16).padStart(64, '0');
  assert(!pool.verifyOpeningPokBlind(it0.inCx, it0.inCy, it0.pokR, zBad, it0.pokZr, ctx), 'tampered pok_z_v rejected');
  ok('(c-neg) redirected-owner context + tampered response rejected');
}

// ── (d) aggregate Pedersen identity per asset ─────────────────────────────────────────────────
const intentsSecp = envelope.intents.map((i) => ({ direction: i.direction, cInSecp: bytesToHex(i.cInSecp) }));
const receiptsCOut = envelope.receipts.map((r) => bytesToHex(r.cOutSecp));
assert(pool.swapBatchAggregateIdentity(intentsSecp, receiptsCOut, true, envelope.deltaANetSign, envelope.deltaANetMag, envelope.tipACSecp, envelope.rNetA), '(d) asset-A aggregate identity holds');
assert(pool.swapBatchAggregateIdentity(intentsSecp, receiptsCOut, false, envelope.deltaBNetSign, envelope.deltaBNetMag, envelope.tipBCSecp, envelope.rNetB), '(d) asset-B aggregate identity holds');
ok('(d) per-asset aggregate Pedersen identity holds (A and B)');

// forgery negative — bump r_net → reject (no unbacked residue accepted).
{
  const badR = '0x' + ((BigInt(envelope.rNetA) + 1n) % N).toString(16).padStart(64, '0');
  assert(!pool.swapBatchAggregateIdentity(intentsSecp, receiptsCOut, true, envelope.deltaANetSign, envelope.deltaANetMag, envelope.tipACSecp, badR), 'wrong r_net_a rejected');
  assert(!pool.swapBatchAggregateIdentity(intentsSecp, receiptsCOut, true, envelope.deltaANetSign, envelope.deltaANetMag + 1n, envelope.tipACSecp, envelope.rNetA), 'wrong delta magnitude rejected');
  ok('(d-neg) wrong r_net / wrong delta rejected');
}

// ── (e) stdin field order + byte lengths (exec-swapblind.rs / main.rs:1665..1815) ─────────────
// Walk the fixture in the harness write order; assert each field's decoded byte length. Any drift
// (a re-ordered or wrong-width field) fails here before it can reach the box.
{
  const b = (h) => hexToBytes(h);
  const eq = (name, val, len) => { assert.strictEqual(val.length, len, `${name} must be ${len} bytes`); };
  // op header (main.rs:1677..1704)
  eq('asset_a', b(fixture.assetA), 32);
  eq('asset_b', b(fixture.assetB), 32);
  assert(fixture.feeBps <= 1000, 'fee_bps <= 1000');
  assert.strictEqual(fixture.protocolFeeBps, 0, 'protocol_fee_bps == 0');
  eq('protocol_fee_recipient', b(fixture.protocolFeeRecipient), 33);
  assert(Number.isInteger(fixture.reserveAPre) && Number.isInteger(fixture.reserveBPre), 'reserves u64');
  assert([0, 1].includes(fixture.deltaANetSign) && [0, 1].includes(fixture.deltaBNetSign), 'delta signs u8 {0,1}');
  eq('r_net_a', b(fixture.rNetA), 32);
  eq('r_net_b', b(fixture.rNetB), 32);
  assert.strictEqual(fixture.tipAAmount, 0, 'tip_a_amount == 0');
  eq('tip_a_c_secp', b(fixture.tipACSecp), 33);
  eq('r_tip_a', b(fixture.rTipA), 32);
  assert.strictEqual(fixture.tipBAmount, 0, 'tip_b_amount == 0');
  eq('tip_b_c_secp', b(fixture.tipBCSecp), 33);
  eq('r_tip_b', b(fixture.rTipB), 32);
  eq('proof', b(fixture.proof), 256);
  // per-intent (main.rs:1732..1788)
  for (const it of fixture.intents) {
    assert([0, 1].includes(it.direction), 'direction u8 {0,1}');
    eq('in_cx', b(it.inCx), 32); eq('in_cy', b(it.inCy), 32);
    eq('in_owner', b(it.inOwner), 32);
    assert(Number.isInteger(it.inLeafIndex), 'in_leaf_index u64');
    assert.strictEqual(it.inPath.length, 32, 'in_path is 32 hashes');
    for (const p of it.inPath) eq('in_path[i]', b(p), 32);
    eq('c_in_bjj', b(it.cInBjj), 32);
    eq('in_sig', b(it.inXcurveSigma), 169);
    assert(Number.isInteger(it.minOut) && Number.isInteger(it.deadline), 'min_out/deadline u64');
    eq('out_cx', b(it.outCx), 32); eq('out_cy', b(it.outCy), 32);
    eq('out_owner', b(it.outOwner), 32);
    eq('c_out_bjj', b(it.cOutBjj), 32);
    eq('out_sig', b(it.outXcurveSigma), 169);
    eq('pok_r', b(it.pokR), 33);
    eq('pok_z_v', b(it.pokZv), 32);
    eq('pok_z_r', b(it.pokZr), 32);
  }
  // fixture field order matches the harness write order (main.rs read order).
  const order = ['note', 'chainBinding', 'spendRoot', 'assetA', 'assetB', 'feeBps', 'protocolFeeBps', 'protocolFeeRecipient', 'reserveAPre', 'reserveBPre', 'deltaANetSign', 'deltaANetMag', 'deltaBNetSign', 'deltaBNetMag', 'rNetA', 'rNetB', 'tipAAmount', 'tipACSecp', 'rTipA', 'tipBAmount', 'tipBCSecp', 'rTipB', 'proof', 'intents', 'expected'];
  assert.deepStrictEqual(Object.keys(fixture), order, 'fixture field order matches the guest read order');
  ok('(e) stdin field order + byte lengths match the guest read order');
}

// ── expected settlement fields populated (harness assert targets) ─────────────────────────────
assert(fixture.spendRoot === spendRoot, 'fixture.spendRoot set');
assert(fixture.expected.poolId && fixture.expected.reserveAPost != null && fixture.expected.reserveBPost != null, 'expected populated');
// self-consistent post-reserves: A grows by amountIn, B shrinks by the receipt out.
assert.strictEqual(fixture.expected.reserveAPost, Number(reserveAPre) + Number(fixture.deltaANetMag), 'reserveAPost = pre + deltaA (A grows)');
assert.strictEqual(fixture.deltaANetSign, 0, 'pool gains A');
assert.strictEqual(fixture.deltaBNetSign, 1, 'pool loses B');
ok('expected.{poolId,reserveAPost,reserveBPost} + spendRoot populated for the harness');

console.log(`\nconfidential-swapblind: ${n} checks passed`);
process.exit(0); // snarkjs keeps curve worker threads alive; exit once the assertions have run.
