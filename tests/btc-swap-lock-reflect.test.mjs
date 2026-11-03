// A Bitcoin-to-Bitcoin swap's leg as the reflection sees it: a tracked note moved by a Tacit transfer into a Taproot lock, and the lock
// claimed by KEY PATH (one Schnorr signature; the secret travels in the claim transfer's kernel signature, not the Bitcoin one) by a
// transfer to the claimer's address. Both transactions' bytes are built here and taken by the reflection's scan (the JS mirror of the
// guest's fold): the claimed note is live, so it bridges in one burn. A claim by a SCRIPT PATH (any leaf: its first witness item is not
// a sighash-flagged signature) folds nothing, nor does a key-path claim signed SIGHASH_SINGLE|ANYONECANPAY: the guest's destination
// binding (cxfer-core bitcoin.rs input_first_witness_item / sig_binds_all_outputs). DUMP=<file> keeps the blocks for the pinned guest.
//   node tests/btc-swap-lock-reflect.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { loadTacit } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { conservingCxfer } from './_conserving-cxfer.mjs';

const tacit = await loadTacit('mainnet');
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const sha = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const h2b = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
const b2h = (b) => Buffer.from(b).toString('hex');
const rev = (h) => h.match(/../g).reverse().join('');
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const le = (v, n) => { const o = new Uint8Array(n); let x = BigInt(v); for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const vi = (n) => (n < 0xfd ? Uint8Array.of(n) : cat(Uint8Array.of(0xfd), le(n, 2)));

function rawTx(vins, vouts) {
  const ins = cat(vi(vins.length), ...vins.map((i) => cat(h2b(rev(i.txid)), le(i.vout, 4), Uint8Array.of(0), le(0xfffffffd, 4))));
  const outs = cat(vi(vouts.length), ...vouts.map((o) => cat(le(o.value, 8), vi(o.script.length), o.script)));
  const wit = cat(...vins.map((i) => cat(vi(i.witness.length), ...i.witness.map((w) => cat(vi(w.length), w)))));
  return { hex: b2h(cat(le(2, 4), Uint8Array.of(0, 1), ins, outs, wit, le(0, 4))), txid: rev(b2h(sha(sha(cat(le(2, 4), ins, outs, le(0, 4)))))), vins: vins.map((i) => ({ txid: i.txid, vout: i.vout })) };
}
const revealed = (payload) => [new Uint8Array(64).fill(1), tacit.encodeEnvelopeScript(new Uint8Array(32).fill(2), payload), cat(Uint8Array.of(0xc0), new Uint8Array(32).fill(3))];
const transferPayload = (inputs, outK) => {
  const cx = conservingCxfer('0x' + TAC, inputs, [outK]);
  return tacit.encodeCXferBppPayload({ assetId: h2b(TAC), kernelSig: h2b(cx.kernelSig), outputs: cx.commitments.map((c) => ({ commitment: h2b(c), encryptedAmount: new Uint8Array(8) })), rangeproof: h2b(cx.rangeProof) });
};
const p2wpkh = (tag) => cat(Uint8Array.of(0x00, 0x14), sha(new TextEncoder().encode(tag)).slice(0, 20));
const p2tr = (xonly) => cat(Uint8Array.of(0x51, 0x20), xonly);

// The desk's tracked note (value 0, blinding k0); the lock holds it under k1; the holder's claimed note is k2.
const DESK = 'd7'.repeat(32), k0 = 0x7001n, k1 = 0x7002n, k2 = 0x7003n;
const LOCK_KEY = new Uint8Array(32).fill(0x4c);                    // the lock's Taproot output key (its leaves: the 2-of-2 claim, the refund)
const leafScript = cat(Uint8Array.of(0x20), new Uint8Array(32).fill(0xd0), Uint8Array.of(0xad, 0x20), new Uint8Array(32).fill(0xe0), Uint8Array.of(0xac)); // a 2-of-2 leaf: <P_desk> CHECKSIGVERIFY <P_holder> CHECKSIG
const controlBlock = cat(Uint8Array.of(0xc0), new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x12));
// A strict-DER P2WPKH signature with SIGHASH_ALL, the shape the destination binding reads.
const derAll = cat(Uint8Array.of(0x30, 0x44, 0x02, 0x20), new Uint8Array(32).fill(0x11), Uint8Array.of(0x02, 0x20), new Uint8Array(32).fill(0x22), Uint8Array.of(0x01));

function legs({ claimWitness = [new Uint8Array(64).fill(9)] } = {}) {
  // The lock: the desk's note (vin[1], its P2WPKH key, SIGHASH_ALL) into the Taproot lock at vout 0.
  const lock = rawTx(
    [{ txid: 'c3'.repeat(32), vout: 0, witness: revealed(transferPayload([{ txid: rev(DESK), vout: 0, k: k0 }], k1)) },
      { txid: DESK, vout: 0, witness: [derAll, cat(Uint8Array.of(2), new Uint8Array(32).fill(6))] }],
    [{ value: 546, script: p2tr(LOCK_KEY) }, { value: 546, script: p2wpkh('desk') }],
  );
  // The claim: the lock (vin[1]) by key path, to the holder at vout 0.
  const claim = rawTx(
    [{ txid: 'c4'.repeat(32), vout: 0, witness: revealed(transferPayload([{ txid: rev(lock.txid), vout: 0, k: k1 }], k2)) },
      { txid: lock.txid, vout: 0, witness: claimWitness }],
    [{ value: 546, script: p2wpkh('holder') }, { value: 546, script: p2wpkh('holder') }],
  );
  return { lock, claim };
}

async function reflect(txs) {
  const ix = makeScanReflectionIndexer({ secp: rootSecp, keccak256: keccak_256, sha256: nobleSha256 });
  const cp = ix.pool, norm = (x) => cp._internal.hx(cp._internal.b32(x));
  const P = rootSecp.ProjectivePoint.BASE.multiply(k0).toAffine();
  const cx = '0x' + P.x.toString(16).padStart(64, '0'), cy = '0x' + P.y.toString(16).padStart(64, '0');
  const key = cp.outpointKey('0x' + rev(DESK), 0);
  ix.state()._acc.live.insert(key, cp.commitmentHash(cx, cy), '0x' + TAC);
  ix.coords().set(norm(key), { cx, cy });
  const input = await ix.assembleBlocks([{ txs: txs.map((t) => ({ txidDisplay: t.txid, rawHex: t.hex, decode: classifyConfidentialTx('0x' + t.hex), vins: t.vins.map((i) => ({ prevTxidDisplay: i.txid, vout: i.vout })) })) }], { headers: [], anchorHeight: 100 });
  const live = (txid, vout) => ix.state()._acc.live.triples().some((x) => String(x[0]).toLowerCase() === String(cp.outpointKey('0x' + rev(txid), vout)).toLowerCase());
  if (process.env.DEBUG_FOLD) console.log(JSON.stringify(input.nonConserving), txs.map((t) => JSON.stringify(classifyConfidentialTx('0x' + t.hex)).slice(0, 160)));
  return { folded: input.blocks[0].txs.map((t) => t.outputs.length), live };
}

const dumped = {};
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a tracked note locked to a Taproot output and claimed by key path is tracked at the claimer\'s address', async () => {
  const { lock, claim } = legs();
  dumped.swap = { live: [{ txid: DESK, vout: 0, k: String(k0) }], txs: [lock, claim] };
  const r = await reflect([lock, claim]);
  assert.deepEqual(r.folded, [1, 1], 'both transfers fold');
  assert.ok(!r.live(DESK, 0), 'the desk\'s note is spent');
  assert.ok(!r.live(lock.txid, 0), 'the lock is spent by the claim');
  assert.ok(r.live(claim.txid, 0), 'the holder\'s claimed note is live: it bridges in one burn');
});

test('a claim by a script path (a 2-of-2 leaf), or by key path signed SIGHASH_SINGLE|ANYONECANPAY, folds nothing', async () => {
  const leaf = legs({ claimWitness: [new Uint8Array(64).fill(9), new Uint8Array(64).fill(10), leafScript, controlBlock] });
  dumped.leaf = { live: [{ txid: DESK, vout: 0, k: String(k0) }], txs: [leaf.lock, leaf.claim] };
  const r = await reflect([leaf.lock, leaf.claim]);
  assert.deepEqual(r.folded, [1, 0], 'a script-path claim is not destination-bound');
  assert.ok(!r.live(leaf.claim.txid, 0));
  const single = legs({ claimWitness: [cat(new Uint8Array(64).fill(9), Uint8Array.of(0x83))] });
  const r2 = await reflect([single.lock, single.claim]);
  assert.deepEqual(r2.folded, [1, 0], 'nor is a signature that leaves outputs free');
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); }
}
if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify({ tac: TAC, ...dumped }));
console.log(`\n${passed}/${tests.length} swap lock reflection checks passed`);
process.exit(passed === tests.length ? 0 : 1);
