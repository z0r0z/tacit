#!/usr/bin/env node
// The fixed-amount atomic settlement (T_AXFER 0x26 / T_AXFER_BPP 0x3C) in the JS reflection mirror:
//   1. KAT: the dapp's own encodeAxferPayload / encodeAxferBppPayload bytes parse in parseCxferEnvelopeFull with the
//      guest layout op ‖ asset ‖ asset_input_count ‖ kernel_sig ‖ N ‖ …; a zero count does not parse; T_CXFER keeps
//      its layout.
//   2. the scan fold takes the kernel inputs from vin[1..1+count]: an extra live note at vin[2] is nullified but the
//      maker's outputs still onboard; an asset input position that is not a live spend folds nothing; a pure CXFER
//      with the same extra input still covers all its spends (and so does not conserve).
//   node tests/confidential-reflection-axfer.mjs

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const { keccak_256 } = await import('../node_modules/@noble/hashes/sha3.js');
const secp = await import('../node_modules/@noble/secp256k1/index.js');
const { createHash } = await import('node:crypto');
const { makeConfidentialPool } = await import('../dapp/confidential-pool.js');
const { parseCxferEnvelopeFull, axferAssetInputCount } = await import('../dapp/burn-deposit-bitcoin.js');
const { conservingCxfer } = await import('./_conserving-cxfer.mjs');
const dapp = await import('../dapp/tacit.js');

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

// ── 1. KAT against the dapp encoders ──
{
  const assetId = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff);
  const kernelSig = Uint8Array.from({ length: 64 }, (_, i) => (i * 17 + 3) & 0xff);
  const commit = (seed) => { const b = new Uint8Array(33); b[0] = 0x02; for (let i = 1; i < 33; i++) b[i] = (i * seed + 11) & 0xff; return b; };
  const outputs = [{ commitment: commit(3), encryptedAmount: new Uint8Array(8).fill(1) }, { commitment: commit(5), encryptedAmount: new Uint8Array(8).fill(2) }];
  const rangeproof = Uint8Array.from({ length: 40 }, (_, i) => i);
  for (const [name, enc, op] of [['T_AXFER', dapp.encodeAxferPayload, 0x26], ['T_AXFER_BPP', dapp.encodeAxferBppPayload, 0x3c]]) {
    const bytes = enc({ assetId, assetInputCount: 3, kernelSig, outputs, rangeproof });
    const p = parseCxferEnvelopeFull(hex(bytes));
    ok(bytes[0] === op && p && p.asset === hex(assetId) && p.kernelSig === hex(kernelSig), `${name}: asset and kernel_sig at the guest offsets`);
    ok(p && p.commitments.length === 2 && p.commitments[0] === hex(outputs[0].commitment) && p.commitments[1] === hex(outputs[1].commitment), `${name}: output commitments`);
    ok(p && p.rangeProof === hex(rangeproof) && p.assetInputCount === 3 && axferAssetInputCount(hex(bytes)) === 3, `${name}: range proof and asset_input_count`);
    const zero = Uint8Array.from(bytes); zero[33] = 0;
    ok(parseCxferEnvelopeFull(hex(zero)) === null, `${name}: asset_input_count 0 does not parse`);
  }
  // T_CXFER (0x23) is unchanged: op ‖ asset ‖ kernel_sig ‖ N ‖ …, with no count.
  const cx = new Uint8Array([0x23, ...assetId, ...kernelSig, 1, ...outputs[0].commitment, ...outputs[0].encryptedAmount, rangeproof.length, 0, ...rangeproof]);
  const pc = parseCxferEnvelopeFull(hex(cx));
  ok(pc && pc.kernelSig === hex(kernelSig) && pc.assetInputCount === null && axferAssetInputCount(hex(cx)) === null, 'T_CXFER: layout unchanged, no asset_input_count');
}

// ── 2. scan fold kernel inputs ──
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b'; // legacy-admissible (a v1 fold onboards)
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ZERO = v(0);
const norm = (x) => pool._internal.hx(pool._internal.b32(x));

function scenario({ opcode, assetInputCount, vins, liveInputs, kernelInputs }) {
  const st = pool.makeScanReflectionState();
  const coords = new Map();
  // Seed every live note (value 0, blinding k) at its outpoint.
  for (const n of liveInputs) {
    const P = secp.ProjectivePoint.BASE.multiply(BigInt(n.k)).toAffine();
    const cx = '0x' + P.x.toString(16).padStart(64, '0'), cy = '0x' + P.y.toString(16).padStart(64, '0');
    const key = pool.outpointKey(n.txid, n.vout);
    st._acc.live.insert(key, pool.commitmentHash(cx, cy), TAC);
    coords.set(norm(key), { cx, cy });
  }
  const cxf = conservingCxfer(TAC, kernelInputs, [0x0a01n]);
  const outs = cxf.commitments.map((comp, j) => {
    const { cx, cy } = pool.decompressCommitment(comp);
    return { cx, cy, compressed: comp, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.btcNoteLeaf(TAC, cx, cy, ZERO), vout: j };
  });
  const tx = { txData: '0xdeadbeef', txid: v(0x71), vins, env: { type: 'cxfer', opcode, assetInputCount, assetId: TAC, kernelSig: cxf.kernelSig, rangeProof: cxf.rangeProof, outputs: outs } };
  return { st, coords, tx };
}
const A = { txid: v(0x60), vout: 0, k: 0x0b01n };  // the maker's asset input
const B = { txid: v(0x61), vout: 1, k: 0x0b02n };  // an extra live note the taker adds
const FUND = { prevTxid: v(0x50), vout: 0 };
const vin = (n) => ({ prevTxid: n.txid, vout: n.vout });

{
  const { st, coords, tx } = scenario({ opcode: 0x26, assetInputCount: 1, vins: [FUND, vin(A), vin(B)], liveInputs: [A, B], kernelInputs: [A] });
  const input = await pool.assembleReflectionScanInput(st, { anchorHeight: 100, headers: [], blocks: [{ txs: [tx] }] }, coords);
  const t = input.blocks[0].txs[0];
  ok(t.openings.length === 2 && t.spentInserts.length === 2, 'axfer + extra live input at vin[2]: both live spends are nullified');
  ok(t.outputs.length === 1 && st.counts().note === 1 && input.nonConserving.length === 0, 'axfer + extra live input at vin[2]: the outputs still onboard (kernel = vin[1])');
}
{
  const { st, coords, tx } = scenario({ opcode: 0x26, assetInputCount: 1, vins: [FUND, vin(B), vin(A)], liveInputs: [A], kernelInputs: [A] });
  const input = await pool.assembleReflectionScanInput(st, { anchorHeight: 100, headers: [], blocks: [{ txs: [tx] }] }, coords);
  ok(input.blocks[0].txs[0].outputs.length === 0 && st.counts().note === 0 && input.nonConserving[0].reason === 'no-live-spends', 'axfer whose vin[1] is not a live spend: folds nothing');
}
{
  const { st, coords, tx } = scenario({ opcode: 0x26, assetInputCount: 2, vins: [FUND, vin(A)], liveInputs: [A], kernelInputs: [A] });
  const input = await pool.assembleReflectionScanInput(st, { anchorHeight: 100, headers: [], blocks: [{ txs: [tx] }] }, coords);
  ok(input.blocks[0].txs[0].outputs.length === 0 && st.counts().note === 0, 'axfer whose asset_input_count runs past the vins: folds nothing');
}
{
  // A pure CXFER spends only its own notes, so every live spend is a kernel input: the extra note breaks conservation.
  const { st, coords, tx } = scenario({ opcode: 0x23, assetInputCount: null, vins: [vin(A), vin(B)], liveInputs: [A, B], kernelInputs: [A] });
  const input = await pool.assembleReflectionScanInput(st, { anchorHeight: 100, headers: [], blocks: [{ txs: [tx] }] }, coords);
  ok(input.blocks[0].txs[0].outputs.length === 0 && st.counts().note === 0, 'cxfer with an extra live input: all spends are kernel inputs (no fold)');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
