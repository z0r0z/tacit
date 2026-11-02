// Offline Bitcoin for the cross-chain swap tests: real commit/reveal transactions built with the wallet's own
// envelope and BIP-341 helpers, run through the real tacit.validateOutpoint. Nothing here reaches a node: any read
// beyond the transactions handed to the validator fails the check and is listed in `fetched`.
// Needs Node 22 (jsdom, like the other validator tests).

import assert from 'node:assert/strict';
import { makeBtcWallet } from '../../dapp/bitcoin-taproot-wallet.js';
import { sha256, bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { G, H, SECP_N, modN, pedersenCommit, bigintToBytes32, signSchnorr } from '../../dapp/bulletproofs.js';
import { loadTacit } from '../../worker-relay/src/lib/btc-pool-transparent.js';
import { bpRangeAggProve } from '../bulletproofs.mjs';

export const te = (s) => new TextEncoder().encode(s);
export const scalar = (tag) => (BigInt('0x' + bytesToHex(sha256(te(tag)))) % (SECP_N - 1n)) + 1n;
export const xonly = (d) => G.multiply(modN(d)).toRawBytes(true).slice(1);
export const eq = (a, b) => bytesToHex(a) === bytesToHex(b);
export const has = (hay, needle) => bytesToHex(hay).includes(bytesToHex(needle));
assert.ok(bytesToHex(H.toRawBytes(true)).startsWith('02bd7bf4'), 'the dapp H is the SPEC generator');

export const { prims: P } = makeBtcWallet({
  priv: bigintToBytes32(scalar('wallet')), hrp: 'tb',
  fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1,
});
export const fetched = [];
globalThis.fetch = async (input) => { fetched.push(String(input?.url ?? input)); throw new Error('offline test: ' + fetched.at(-1)); };
export const tacit = await loadTacit('signet');

export const COMMIT_VALUE = 2000, NOTE_VALUE = 546;
const noAmount = new Uint8Array(8);
let seq = 0;

// A commit/reveal pair. `inputs` are the note inputs (vin[1..]): { txid, vout, value, spk, sequence?, sign(tx, idx, prevouts) -> witness }.
// The reveal's vin[0] spends the commit output by script path under `signerD`, exactly as the wallet does.
export function buildOp({ payload, signerD, inputs = [], outputs, height = 330000 }) {
  const script = P.encodeEnvelopeScript(xonly(signerD), payload);
  const leaf = P.tapLeafHash(script);
  const { Q_xonly, parity } = P.tweakedOutputKey(P.TAP_NUMS, leaf);
  const commitSpk = P.p2trScript(Q_xonly);
  const commitTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: bytesToHex(sha256(te('funding' + seq++))), vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: COMMIT_VALUE, script: commitSpk }],
  };
  const reveal = {
    version: 2, locktime: 0,
    inputs: [{ txid: P.txid(commitTx), vout: 0, sequence: 0xfffffffd, witness: [] },
      ...inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: i.sequence ?? 0xfffffffd, witness: [] }))],
    outputs: outputs.map((o) => ({ value: o.value ?? NOTE_VALUE, script: o.script })),
  };
  const prevouts = [{ value: COMMIT_VALUE, script: commitSpk }, ...inputs.map((i) => ({ value: i.value, script: i.spk }))];
  const sh0 = P.tapSighash(reveal, 0, prevouts, leaf, 0x00);
  reveal.inputs[0].witness = [signSchnorr(sh0, bigintToBytes32(signerD)), script, P.controlBlock(P.TAP_NUMS, parity)];
  inputs.forEach((i, k) => { reveal.inputs[k + 1].witness = i.sign(reveal, k + 1, prevouts); });
  const txid = P.txid(reveal);
  const esplora = {
    txid, status: { confirmed: true, block_height: height },
    vin: reveal.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })),
    vout: reveal.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })),
  };
  return { txid, commitTx, commitSpk, script, leaf, sh0, signerXonly: xonly(signerD), reveal, prevouts, esplora };
}

export const p2trKey = (xo) => P.p2trScript(xo);
export const keyPathSigner = (d) => (tx, idx, prevouts) => [signSchnorr(P.tapSighashKeyPath(tx, idx, prevouts, 0x00), typeof d === 'bigint' ? bigintToBytes32(d) : d)];
export const fetchFrom = (...ops) => { const m = new Map(ops.map((o) => [o.txid, o.esplora])); return async (id) => m.get(id) || null; };
export const validate = async (fetchTx, txid, vout) => {
  const reasons = new Map();
  const ok = await tacit.validateOutpoint(txid, vout, new Map(), fetchTx, 0, null, null, null, reasons);
  return { ok, reason: reasons.get(`${txid}:${vout}`) };
};

export const C = (v, r) => pedersenCommit(v, r).toRawBytes(true);

// A confidential transfer reveal: ins [{ txid, vout, value, spk, sign, sequence?, r }] -> outs [{ value, r, script }].
export function cxfer(asset, ins, outs, { signerD, kernelKey, extra = [], height } = {}) {
  const Cs = outs.map((o) => C(o.value, o.r));
  const { proof } = bpRangeAggProve(outs.map((o) => o.value), outs.map((o) => o.r));
  const msg = tacit.computeKernelMsg(asset, ins.map((i) => ({ txid: i.txid, vout: i.vout })), Cs, 0n);
  const d = modN(outs.reduce((a, o) => a + o.r, 0n) - ins.reduce((a, i) => a + i.r, 0n));
  const kernelSig = signSchnorr(msg, bigintToBytes32(kernelKey ?? d));
  const payload = tacit.encodeCXferPayload({ assetId: asset, kernelSig, outputs: Cs.map((commitment) => ({ commitment, encryptedAmount: noAmount })), rangeproof: proof });
  const op = buildOp({ payload, signerD: signerD ?? scalar('signer' + seq), inputs: ins, outputs: [...outs.map((o) => ({ script: o.script })), ...extra], height });
  return { ...op, kernelSig };
}

// An etch: the supply note (value, r) at `script`.
export function etchNote({ ticker = 'TP', value, r, script, signerD = scalar('etcher') }) {
  const { proof } = bpRangeAggProve([value], [r]);
  const payload = tacit.encodeCEtchPayload({ ticker, decimals: 0, commitment: C(value, r), rangeproof: proof, encryptedAmount: noAmount });
  const op = buildOp({ payload, signerD, outputs: [{ script }] });
  return { ...op, asset: tacit.assetIdFor(op.txid, 0) };
}
