// One Bitcoin transaction that swaps a holder's shielded-pool TAC for TAC Bitcoin's proof tracks: a desk's tracked note goes to the
// holder by an atomic settlement at vin[0] (T_AXFER_BPP, the desk's note at vin[1]), and the holder's pool spend, carried on a later
// input and bound to the holder's own coin, pays the desk in the pool. The transaction's bytes are built here and each reader takes
// them as it takes a block's: the reflection's scan (the JS mirror of the guest's fold), the shielded pool's replay with a real Halo2
// proof of the spend, and the dapp's note validator. Then what must not pass does not: the spend copied into a carrier without the
// holder's coin, a settlement whose kernel does not conserve, and one whose asset input is not the desk's tracked note.
//   node tests/pool-swap-carrier.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import * as bp from '../worker/src/btc-shielded-pool.js';
import { parseTx, txEnvelopes } from '../worker-relay/src/lib/btc-pool-chain.js';
import { loadTacit } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { conservingCxfer } from './_conserving-cxfer.mjs';

const tacit = await loadTacit('mainnet');
const pool = makeBtcShieldedPool({ secp: rootSecp, keccak256: keccak_256, sha256: nobleSha256 });
const PIN_DIR = new URL('../dapp/btc-pool/', import.meta.url);
const PIN = JSON.parse(readFileSync(new URL('pin.json', PIN_DIR), 'utf8'));
const art = (n) => new Uint8Array(readFileSync(new URL(n, PIN_DIR)));
const sys = makeHalo2System({ wasm: art(PIN.wasm), params: art(PIN.params), vk: art(PIN.vk), pinnedVkHash: PIN.vk_hash, worker: null });
const verifyProof = ({ proof, publics }) => sys.verify(publics, proof);

const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const sha = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const h2b = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
const b2h = (b) => Buffer.from(b).toString('hex');
const rev = (h) => h.match(/../g).reverse().join('');
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const le = (v, n) => { const o = new Uint8Array(n); let x = BigInt(v); for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const vi = (n) => (n < 0xfd ? Uint8Array.of(n) : n <= 0xffff ? cat(Uint8Array.of(0xfd), le(n, 2)) : cat(Uint8Array.of(0xfe), le(n, 4)));
const p2wpkh = (tag) => cat(Uint8Array.of(0x00, 0x14), sha(new TextEncoder().encode(tag)).slice(0, 20));

let passed = 0;
const tests = [];
// SWAP_DUMP=<file> keeps the transactions checked here, for the pinned reflection guest (tests/gen-reflection-pool-swap-synth.mjs).
const dumped = {};
const keep = (name, t) => { dumped[name] = { hex: t.hex, txid: t.txid, vins: t.vins.map((i) => ({ txid: i.txid, vout: i.vout })) }; };
const test = (name, fn) => tests.push([name, fn]);

// A segwit transaction from its inputs ({ txid display, vout, witness: [bytes] }) and outputs ({ value, script }): its raw hex and txid.
function rawTx(vins, vouts) {
  const ins = cat(vi(vins.length), ...vins.map((i) => cat(h2b(rev(i.txid)), le(i.vout, 4), Uint8Array.of(0), le(0xffffffff, 4))));
  const outs = cat(vi(vouts.length), ...vouts.map((o) => cat(le(o.value, 8), vi(o.script.length), o.script)));
  const wit = cat(...vins.map((i) => cat(vi(i.witness.length), ...i.witness.map((w) => cat(vi(w.length), w)))));
  const base = cat(le(2, 4), ins, outs, le(0, 4));
  const txid = rev(b2h(sha(sha(base))));
  return { hex: b2h(cat(le(2, 4), Uint8Array.of(0, 1), ins, outs, wit, le(0, 4))), txid };
}
// A Tacit envelope revealed by a Taproot script path: [signature, envelope script, control block].
const revealed = (payload) => [new Uint8Array(64).fill(1), tacit.encodeEnvelopeScript(new Uint8Array(32).fill(2), payload), cat(Uint8Array.of(0xc0), new Uint8Array(32).fill(3))];
const keyed = () => [new Uint8Array(71).fill(4), cat(Uint8Array.of(2), new Uint8Array(32).fill(5))];
// The same transaction as the dapp's explorer reads it.
const esploraOf = (t, vins, vouts) => ({
  txid: t.txid, status: { confirmed: true, block_height: 970000 },
  vin: vins.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(b2h), prevout: { scriptpubkey_type: i.type || 'v0_p2wpkh' } })),
  vout: vouts.map((o) => ({ value: o.value, scriptpubkey: b2h(o.script) })),
});

// ── the parties ──
// The desk's tracked note: a T_CXFER_BPP output (value 0, blinding kIn) the reflection holds live.
const DESK_LOT = 'd5'.repeat(32), kIn = 0x5eed1n, kOut = 0x5eed2n;
const holderScript = p2wpkh('holder'), deskScript = p2wpkh('desk');
// The holder's coin, which the pool spend is bound to and which only the holder can sign for.
const BIND = { txid: 'b1'.repeat(32), vout: 0 };
const COMMIT = { txid: 'c0'.repeat(32), vout: 0 };     // the holder's commit for the settlement's envelope
const CARRIER = { txid: 'c1'.repeat(32), vout: 0 };    // the holder's commit for the pool spend's envelope

// The settlement: the desk's note (vin[1]) to a new note at the holder's address (vout 0).
function settlement({ input = { txid: rev(DESK_LOT), vout: 0, k: kIn }, outK = kOut } = {}) {
  const cx = conservingCxfer('0x' + TAC, [input], [outK]);
  const payload = tacit.encodeAxferBppPayload({
    assetId: h2b(TAC), assetInputCount: 1, kernelSig: h2b(cx.kernelSig),
    outputs: cx.commitments.map((c) => ({ commitment: h2b(c), encryptedAmount: new Uint8Array(8) })), rangeproof: h2b(cx.rangeProof),
  });
  return { payload, cx };
}

// The holder's pool note (1,000 TAC, shielded), and its spend paying the desk's pool address, bound to the holder's coin.
async function poolSide() {
  const holder = pool.walletFromSeed(new Uint8Array(32).fill(7), 'mainnet');
  const desk = pool.walletFromSeed(new Uint8Array(32).fill(8), 'mainnet');
  const r0 = 4242n, C = pool.commitXY(1000n, r0);
  const txin = { txid: 'ab'.repeat(32), vout: 1, value: 1000n, blinding: r0, Cx: C.cx, Cy: C.cy };
  const sh = pool.buildShieldEnvelope({ asset: '0x' + TAC, inputs: [txin], recipientAddress: holder.addressString });
  const { payload: shPayload } = await pool.prove(sh, sys);
  const st = new bp.BtcPoolState();
  st.beginBlock(100);
  const rs = await st.acceptShield(bp.parseEnvelope(shPayload), {
    txid: 'ee'.repeat(32), inputs: [{ txid: 'aa'.repeat(32), vout: 0 }, { txid: txin.txid, vout: 1 }], verifyProof,
    resolveInput: async (op, a) => (op.txid === txin.txid && op.vout === 1 && a === TAC ? { cx: C.cx, cy: C.cy } : null),
  });
  assert.ok(rs.accepted, rs.reason);
  st.endBlock();
  for (let h = 101; h <= 110; h++) { st.beginBlock(h); st.endBlock(); }
  const mine = pool.scan(holder, rs.leaves);
  const { root, path } = st.tree.rootAndPathAt(mine[0].leafIndex, st.leafCountAt(102));
  const body = pool.buildSpendBody({ asset: '0x' + TAC, hAnchor: 102, root, inputs: [{ ...mine[0], path }], outputs: [{ address: desk.addressString, value: 1000n }], bind: BIND, wallet: holder });
  const { payload } = await pool.prove(body, sys);
  return { st, desk, payload };
}

// The swap: the settlement's envelope on vin[0], the desk's note on vin[1], the pool spend on vin[2], the holder's coin on vin[3].
function swapTx({ axfer, spend, bind = true, deskInput = { txid: DESK_LOT, vout: 0 } }) {
  const vins = [
    { ...COMMIT, witness: revealed(axfer), type: 'v1_p2tr' },
    { ...deskInput, witness: keyed() },
    { ...CARRIER, witness: revealed(spend), type: 'v1_p2tr' },
    ...(bind ? [{ ...BIND, witness: keyed() }] : []),
  ];
  const vouts = [{ value: 546, script: holderScript }, { value: 20000, script: holderScript }];
  return { vins, vouts, ...rawTx(vins, vouts) };
}

// The reflection's scan of one block holding `t`, with the desk's note live before it: what it folds.
async function reflect(t, { live = [{ txid: rev(DESK_LOT), vout: 0, k: kIn }] } = {}) {
  const ix = makeScanReflectionIndexer({ secp: rootSecp, keccak256: keccak_256, sha256: nobleSha256 });
  const cp = ix.pool, norm = (x) => cp._internal.hx(cp._internal.b32(x));
  for (const n of live) {
    const P = rootSecp.ProjectivePoint.BASE.multiply(n.k).toAffine();
    const cx = '0x' + P.x.toString(16).padStart(64, '0'), cy = '0x' + P.y.toString(16).padStart(64, '0');
    const key = cp.outpointKey('0x' + n.txid, n.vout);
    ix.state()._acc.live.insert(key, cp.commitmentHash(cx, cy), '0x' + TAC);
    ix.coords().set(norm(key), { cx, cy });
  }
  const input = await ix.assembleBlocks([{ txs: [{ txidDisplay: t.txid, rawHex: t.hex, decode: classifyConfidentialTx('0x' + t.hex), vins: t.vins.map((i) => ({ prevTxidDisplay: i.txid, vout: i.vout })) }] }], { headers: [], anchorHeight: 100 });
  const swapKey = cp.outpointKey('0x' + rev(t.txid), 0);
  const tracked = ix.state()._acc.live.triples().some((x) => String(x[0]).toLowerCase() === String(swapKey).toLowerCase());
  return { folded: input.blocks[0].txs[0].outputs.length, tracked, deskSpent: !ix.state()._acc.live.triples().some((x) => String(x[0]).toLowerCase() === String(cp.outpointKey('0x' + rev(DESK_LOT), 0)).toLowerCase()) };
}

// The pool's replay of the same bytes: every input's envelope, as it reads a carrier, at a later block.
async function replay(st, t, n) {
  const { tx } = parseTx(h2b(t.hex));
  assert.equal(tx.txid, t.txid, 'the pool reads the same txid');
  const { vin0TacitOp, items } = bp.carrierPoolEnvelopes(txEnvelopes(tx));
  st.beginBlock(n);
  const out = [];
  for (const it of items) out.push({ vin: it.vin, r: await st.acceptSpend(bp.parseEnvelope(it.payload), { txid: t.txid, inputs: tx.vin, outputs: tx.vout, vin0TacitOp, verifyProof }) });
  st.endBlock();
  return { vin0TacitOp, out };
}

// The dapp's validator on the holder's new note, with the desk's note known valid and its parent a T_CXFER_BPP that made it.
async function validates(t) {
  const deskParent = (() => {
    const cx = conservingCxfer('0x' + TAC, [{ txid: '99'.repeat(32), vout: 0, k: 7n }], [kIn]);
    const payload = tacit.encodeCXferBppPayload({ assetId: h2b(TAC), kernelSig: h2b(cx.kernelSig), outputs: cx.commitments.map((c) => ({ commitment: h2b(c), encryptedAmount: new Uint8Array(8) })), rangeproof: h2b(cx.rangeProof) });
    const vins = [{ txid: '98'.repeat(32), vout: 0, witness: revealed(payload), type: 'v1_p2tr' }], vouts = [{ value: 546, script: deskScript }];
    return esploraOf({ txid: DESK_LOT }, vins, vouts);
  })();
  const txs = new Map([[t.txid, esploraOf(t, t.vins, t.vouts)], [DESK_LOT, deskParent]]);
  const set = new Map([[`${DESK_LOT}:0`, true]]), reasons = new Map();
  const ok = await tacit.validateOutpoint(t.txid, 0, set, async (id) => txs.get(id) || null, 0, null, null, null, reasons);
  return ok;
}

let SIDE = null;
const side = async () => (SIDE ??= await poolSide());

test('the swap folds: the reflection tracks the holder\'s new note, the pool pays the desk, and the dapp takes the note as TAC', async () => {
  const { st, desk, payload } = await side();
  const t = swapTx({ axfer: settlement().payload, spend: payload });
  keep('swap', t);
  const d = classifyConfidentialTx('0x' + t.hex);
  assert.equal(d.type, 'cxfer'); assert.equal(d.opcode, 0x3c); assert.equal(d.assetInputCount, 1);
  const rf = await reflect(t);
  assert.equal(rf.folded, 1, 'the settlement\'s output onboards');
  assert.ok(rf.tracked, 'the holder\'s new note is live in the reflection: it bridges in one burn');
  assert.ok(rf.deskSpent, 'the desk\'s note is spent');
  const rp = await replay(st, t, 111);
  assert.equal(rp.vin0TacitOp, true, 'the pool sees a transparent op on vin[0]');
  assert.deepEqual(rp.out.map((x) => x.vin), [2], 'and reads the spend on vin[2]');
  assert.ok(rp.out[0].r.accepted, rp.out[0].r.reason);
  assert.deepEqual(pool.scan(desk, rp.out[0].r.leaves).map((x) => x.value), [1000n], 'the desk is paid 1,000 TAC in the pool');
  assert.equal(await validates(t), true, 'the dapp validates the holder\'s new note');
});

test('the spend copied into a carrier without the holder\'s coin is refused, so it moves only in the transaction the holder signs', async () => {
  const { payload } = await side();
  const st2 = (await poolSide()).st; // a fresh replay where the note is unspent
  const copy = swapTx({ axfer: settlement().payload, spend: payload, bind: false });
  const rp = await replay(st2, copy, 111);
  assert.match(rp.out[0].r.reason, /bound outpoint/);
});

test('a settlement that does not conserve, or whose asset input is not the desk\'s tracked note, folds nothing and does not validate', async () => {
  const { payload } = await side();
  const bad = swapTx({ axfer: settlement({ input: { txid: rev(DESK_LOT), vout: 0, k: kIn + 5n } }).payload, spend: payload });
  keep('bad', bad);
  const rf = await reflect(bad);
  assert.equal(rf.folded, 0, 'a kernel over the wrong input value folds nothing');
  assert.equal(rf.tracked, false);
  assert.equal(await validates(bad), false, 'and the dapp refuses it, so a holder checking before signing does not sign it');
  const other = swapTx({ axfer: settlement({ input: { txid: rev('d6'.repeat(32)), vout: 0, k: kIn } }).payload, spend: payload, deskInput: { txid: 'd6'.repeat(32), vout: 0 } });
  const rf2 = await reflect(other);
  assert.equal(rf2.folded, 0, 'an asset input the reflection does not hold folds nothing');
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); }
}
if (process.env.SWAP_DUMP) writeFileSync(process.env.SWAP_DUMP, JSON.stringify({ tac: TAC, deskLot: DESK_LOT, kIn: String(kIn), ...dumped }));
console.log(`\n${passed}/${tests.length} pool swap carrier checks passed`);
process.exit(passed === tests.length ? 0 : 1);
