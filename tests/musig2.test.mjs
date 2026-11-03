// MuSig2 with an adaptor point (dapp/musig2.js): BIP-327's key aggregation vector; two parties' signatures, plain and adapted,
// accepted by the wallet's BIP-340 verifier under a Taproot output key the wallet derives itself; t read back from the published
// signature; and what is refused: a wrong partial signature, a used secret nonce, a t that does not open T.
//   node tests/musig2.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../dapp/musig2.js';
import { G, SECP_N, bigintToBytes32, verifySchnorr } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes, sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';

const scalar = (tag) => (BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode(tag)))) % (SECP_N - 1n)) + 1n;
const pub = (d) => G.multiply(d).toRawBytes(true);
const { prims } = makeBtcWallet({ priv: bigintToBytes32(scalar('w')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 });

test('KeyAgg matches BIP-327\'s vector', () => {
  const X = ['02F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9', '03DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659', '023590A94E768F8E1815C2F24B4D80A8E3149316C3518CE7B7AD338368D038CA66'].map(hexToBytes);
  assert.equal(bytesToHex(M.keyAgg([X[0], X[1], X[2]]).xonly).toUpperCase(), '90539EEDE565F5D054F32CC0C220126889ED1E5D193BAF15AEF344FE59D4610C');
  assert.equal(bytesToHex(M.keyAgg([X[2], X[1], X[0]]).xonly).toUpperCase(), '6204DE8B083426DC6EAF9502D27024D53FC826BF7D2012148A0575435DF54B2B');
  assert.equal(bytesToHex(M.keyAgg([X[0], X[0], X[0]]).xonly).toUpperCase(), 'B436E3BAD62B8CD409969A224731C193D051162D8C5AE8B109306127DA3AA935');
});

function sign2({ dA, dB, msg, t = null, leafHash = null }) {
  const pks = M.keySort([pub(dA), pub(dB)]);
  const inner = M.keyAgg(pks);
  const keys = leafHash ? M.keyAgg(pks, [M.tapTweak(inner.xonly, leafHash)]) : inner;
  const nA = M.nonceGen({ sk: bigintToBytes32(dA), pk: pub(dA), aggXonly: keys.xonly, msg });
  const nB = M.nonceGen({ pk: pub(dB) });
  const T = t ? G.multiply(t) : null;
  const sess = M.session({ keys, pubnonces: [nA.pubnonce, nB.pubnonce], msg, T });
  const sA = M.partialSign({ secnonce: nA.secnonce, sk: dA, sess });
  const sB = M.partialSign({ secnonce: nB.secnonce, sk: dB, sess });
  assert.ok(M.partialVerify({ psig: sA, pubnonce: nA.pubnonce, pk: pub(dA), sess }));
  assert.ok(M.partialVerify({ psig: sB, pubnonce: nB.pubnonce, pk: pub(dB), sess }));
  return { keys, inner, sess, sA, sB, nA, nB, s: M.partialAgg({ psigs: [sA, sB], sess }) };
}

test('two parties sign under the aggregate key and under its Taproot output key, for every parity', () => {
  for (let i = 0; i < 16; i++) {
    const dA = scalar('a' + i), dB = scalar('b' + i), msg = sha256(new TextEncoder().encode('m' + i));
    const plain = sign2({ dA, dB, msg });
    assert.ok(verifySchnorr(new Uint8Array([...plain.sess.Rf.toRawBytes(true).slice(1), ...bigintToBytes32(plain.s)]), msg, plain.keys.xonly), 'plain ' + i);
    const leafHash = sha256(new TextEncoder().encode('leaf' + i));
    const tr = sign2({ dA, dB, msg, leafHash });
    assert.equal(bytesToHex(tr.keys.xonly), bytesToHex(prims.tweakedOutputKey(tr.inner.xonly, leafHash).Q_xonly), 'the wallet derives the same output key');
    assert.ok(verifySchnorr(new Uint8Array([...tr.sess.Rf.toRawBytes(true).slice(1), ...bigintToBytes32(tr.s)]), msg, tr.keys.xonly), 'taproot ' + i);
  }
});

test('adapted: the pre-signature checks against T, completes with t to a valid signature, and gives t back', () => {
  for (let i = 0; i < 16; i++) {
    const t = scalar('t' + i), msg = sha256(new TextEncoder().encode('am' + i)), leafHash = sha256(new TextEncoder().encode('al' + i));
    const r = sign2({ dA: scalar('aa' + i), dB: scalar('bb' + i), msg, t, leafHash });
    assert.ok(M.preVerify({ sPre: r.s, sess: r.sess }));
    assert.ok(!verifySchnorr(new Uint8Array([...r.sess.Rf.toRawBytes(true).slice(1), ...bigintToBytes32(r.s)]), msg, r.keys.xonly), 'the pre-signature alone is not a signature');
    const sig = M.adapt({ sPre: r.s, t, sess: r.sess });
    assert.ok(verifySchnorr(sig, msg, r.keys.xonly), 'adapted ' + i);
    assert.equal(M.extract({ sig, sPre: r.s, sess: r.sess }), t);
  }
});

test('refused: a wrong partial signature, a secret nonce used twice, a t that does not open T, a signature not from this pre-signature', () => {
  const t = scalar('t'), msg = sha256(new TextEncoder().encode('x'));
  const r = sign2({ dA: scalar('A'), dB: scalar('B'), msg, t });
  const bad = bigintToBytes32((BigInt('0x' + bytesToHex(r.sA)) + 1n) % SECP_N);
  assert.equal(M.partialVerify({ psig: bad, pubnonce: r.nA.pubnonce, pk: pub(scalar('A')), sess: r.sess }), false);
  assert.equal(M.partialVerify({ psig: r.sA, pubnonce: r.nB.pubnonce, pk: pub(scalar('A')), sess: r.sess }), false, 'another signer\'s nonce');
  assert.throws(() => M.partialSign({ secnonce: r.nA.secnonce, sk: scalar('A'), sess: r.sess }), /used already/);
  assert.throws(() => M.adapt({ sPre: r.s, t: t + 1n, sess: r.sess }), /does not open/);
  const other = sign2({ dA: scalar('A'), dB: scalar('B'), msg, t });
  assert.equal(M.extract({ sig: M.adapt({ sPre: other.s, t, sess: other.sess }), sPre: r.s, sess: r.sess }), null);
  const n = M.nonceGen({ pk: pub(scalar('A')) });
  assert.throws(() => M.partialSign({ secnonce: n.secnonce, sk: scalar('B'), sess: r.sess }), /another key/);
});
