// Shielded-pool relayer (DESIGN-btc-shielded-pool.md §6) with mocked pool view, chain and mempool. Most tests
// use a stub verifier (a wire whose first byte is 1 verifies) and check the publics the relayer derives; the
// "real proof" tests prove spend.circom and verify natively through makeBtcPoolVerifier.
//   node worker-relay/tests/btc-pool-relayer.test.mjs

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as snarkjs from 'snarkjs';
import { secp, sha256, keccak_256, hexToBytes, bytesToHex, concatBytes } from '../../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../../dapp/btc-shielded-pool.js';
import { makeGroth16System, PROOF_WIRE_LEN } from '../../dapp/btc-pool-zk-prover.js';
import { makeBtcWallet } from '../../dapp/bitcoin-taproot-wallet.js';
import { PoseidonTree } from '../../worker/src/btc-shielded-pool.js';
import { parseTx } from '../src/lib/btc-pool-chain.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRelayer, tapScriptSighash, spendNullifiersOfTx, parseFees, spendPublics, poolViewFromIndexer,
  makeMempoolWatch, makeBitcoindMempool, makeBitcoindRpc, spendsOfTx,
} from '../src/lib/btc-pool-relayer.js';
import { makeBtcPoolVerifier, DEFAULT_PIN_PATH } from '../src/lib/btc-pool-verify.js';
import { openBtcPoolStore } from '../src/lib/btc-pool-store.js';
import { createIndexer } from '../src/btc-pool-indexer.js';

const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const strip = (h) => String(h).replace(/^0x/, '');
const ASSET = '0x' + 'ab'.repeat(32);
const FEE = 10n;
const TIP = 1000;
const ANCHOR = 996;
const BTC_KEY = rnd(32); BTC_KEY[0] = 1;
const POOL_SEED = rnd(32);

const alice = bp.walletFromSeed(rnd(32), 'signet');
const bob = bp.walletFromSeed(rnd(32), 'signet');
const eve = bp.walletFromSeed(rnd(32), 'signet');
const relayerWallet = bp.walletFromSeed(POOL_SEED, 'signet');

const p2wpkh = (tag) => concatBytes(Uint8Array.of(0x00, 0x14), sha256(new TextEncoder().encode(tag)).slice(0, 20));
const p2tr = (tag) => concatBytes(Uint8Array.of(0x51, 0x20), sha256(new TextEncoder().encode(tag)));

let leafCounter = 0;
function ownedNote(value = 100n) {
  const n = bp.createNote(alice.addressString, ASSET, value);
  const r = bp.tryReceive(alice, { ...n, leafIndex: leafCounter++ });
  assert.ok(r && r.nf && r.skNote);
  return r;
}
// Relayer coins; the smallest free confirmed one becomes a batch's bind.
const COINS = [
  { txid: 'ee'.repeat(32), vout: 1, value: 200_000 }, { txid: 'dd'.repeat(32), vout: 0, value: 50_000 },
  { txid: 'cc'.repeat(32), vout: 2, value: 30_000 }, { txid: 'bb'.repeat(32), vout: 3, value: 20_000 },
  { txid: 'aa'.repeat(32), vout: 4, value: 25_000 },
];
const FIRST_BIND = { txid: 'bb'.repeat(32), vout: 3 };
// Stub wires: first byte 1 verifies under the stub verifier, anything else does not.
const wire = (b0) => { const w = new Uint8Array(PROOF_WIRE_LEN); w[0] = b0; w[1] = 2; return w; };
const OK_PROOF = wire(1);
const BAD_PROOF = wire(9);
function payloadFor({ notes, outputs, exit = null, bind = FIRST_BIND, want = null, hAnchor = ANCHOR, proof = OK_PROOF }) {
  const b = bp.buildSpendBody({ asset: ASSET, hAnchor, inputs: notes, outputs, exit, bind, want });
  return { hex: bytesToHex(bp.assembleSpendEnvelope(b.body, proof)), nullifiers: b.nullifiers.map(strip), body: b.body, exit: b.exit };
}
// Flips one byte inside the exit boundary's sigma proof; the body still parses.
function corruptBoundary(hex) {
  const bytes = hexToBytes(hex);
  const s = bp.parseSpend(bytes, { full: true });
  const at = s.body.length - 1 - 825 + 65 + 40; // has_want is the last body byte; boundary precedes it
  bytes[at] ^= 1;
  return bytesToHex(bytes);
}
const ANCHOR_ROOT = '0a'.repeat(32);

async function setup(over = {}, { open = true } = {}) {
  const roots = new Map([[ANCHOR, ANCHOR_ROOT], [990, '0b'.repeat(32)], [860, '0c'.repeat(32)], [870, '01'.repeat(32)], [875, '02'.repeat(32)]]);
  const spent = new Set();
  const pending = new Map();
  const pool = {
    t: TIP, ct: null, complete: true,
    tip() { return this.t; }, chainTip() { return this.ct ?? this.t; }, rootAt: (h) => roots.get(h) || null, isSpent: (nf) => spent.has(strip(nf)),
    pendingSpend: (nf) => pending.get(strip(nf)) || null, aheadComplete() { return this.complete; },
  };
  const verifyCalls = [];
  const verifier = over.verifier || {
    enabled: true,
    verify: async ({ proof, publics }) => {
      verifyCalls.push({ proof, publics });
      await new Promise((r) => setTimeout(r, 5));
      return proof[0] === 1;
    },
  };
  const broadcasts = [];
  const attempts = [];
  const failQueue = [];
  const statuses = new Map();
  const txidOf = (hex) => parseTx(hexToBytes(hex)).tx.txid;
  const chain = {
    utxos: async () => COINS.map((c) => ({ ...c, status: { confirmed: true } })),
    feeRate: async () => 2,
    broadcast: async (hex) => {
      attempts.push(hex);
      const f = failQueue.shift();
      if (f === 'lost') throw new Error('socket hang up');
      if (f === 'landed') { statuses.set(txidOf(hex), { confirmed: false }); throw new Error('socket hang up'); }
      broadcasts.push(hex);
      return 'ok';
    },
    txStatus: async (txid) => statuses.get(txid) || null,
  };
  const mempoolNfs = new Map();
  const mempool = {
    refresh: async () => {},
    conflict: (nfs, ignore = new Set()) => { for (const [t, s] of mempoolNfs) if (!ignore.has(t) && nfs.some((n) => s.has(n))) return t; return null; },
  };
  let clock = 1_700_000_000_000;
  const relayer = createRelayer({
    network: 'signet', btcKey: BTC_KEY, poolSeed: POOL_SEED, fees: { [ASSET]: FEE }, pool, verifier, chain, mempool,
    batchMs: 60_000, now: () => clock, ...over,
  });
  // Opens a batch through a quote and drops the quote, so nothing counts as outstanding.
  const openBatch = async () => { const q = await relayer.quote({ asset: ASSET }); relayer._state.quotes.delete(q.quoteId); return q.bind; };
  const s = { relayer, pool, roots, spent, pending, verifier, verifyCalls, chain, broadcasts, attempts, failQueue, statuses, mempoolNfs, openBatch, advance: (ms) => { clock += ms; } };
  if (open) s.bind = await openBatch();
  return s;
}

const tests = [];
const test = (n, f) => tests.push([n, f]);
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('relayer address is the pool wallet derived from its seed', async () => {
  const { relayer } = await setup();
  assert.equal(relayer.address, relayerWallet.addressString);
  assert.match(relayer.fundAddress, /^tb1q/);
  assert.equal(relayer.info().fees[ASSET], '10');
});

test('accept: fee note fully received, proof checked against the replayed root', async () => {
  const s = await setup();
  const q = await s.relayer.quote({ asset: ASSET });
  assert.deepEqual(q.bind, FIRST_BIND, 'the smallest confirmed coin');
  assert.equal(q.fee, '10');
  assert.equal(q.address, relayerWallet.addressString);
  assert.equal(q.exitVout, null);
  const p = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: q.address, value: 10n }, { address: bob.addressString, value: 90n }], bind: q.bind });
  const r = await s.relayer.submit({ payload: p.hex, quoteId: q.quoteId });
  assert.equal(s.relayer.status(r.id).state, 'held');
  assert.equal(s.verifyCalls.length, 1);
  assert.ok(s.relayer._state.reservedUtxos.has(`${FIRST_BIND.txid}:${FIRST_BIND.vout}`));
  const want = bp.payloadPublics(p.hex, { root: '0x' + ANCHOR_ROOT }).publics;
  assert.equal(want.length, 12);
  assert.deepEqual(s.verifyCalls[0].publics, want, 'publics against the root at h_anchor');
  assert.deepEqual(spendPublics(hexToBytes(p.hex), ANCHOR_ROOT), want);
  assert.equal(want[0], BigInt('0x' + ANCHOR_ROOT).toString());
  assert.equal(bytesToHex(s.verifyCalls[0].proof), bytesToHex(OK_PROOF));
  for (const nf of p.nullifiers) assert.equal(s.relayer._state.holds.get(nf), r.id);
});

test('bind: the payload must sign the quoted outpoint of an open batch; zero bind and wants are refused', async () => {
  const s = await setup();
  const q = await s.relayer.quote({ asset: ASSET });
  const outs = () => [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs(), bind: null }).hex }), /no bind/);
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs(), bind: { txid: 'bb'.repeat(32), vout: 4 } }).hex, quoteId: q.quoteId }), /not the quoted outpoint/);
  await assert.rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs(), bind: { txid: '99'.repeat(32), vout: 0 } }).hex }), (e) => e.status === 409 && /no open carrier/.test(e.message));
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs(), want: { vout: 0, value: 1000n, scriptPubKey: p2tr('w') } }).hex, quoteId: q.quoteId }), /want is not relayed/);
  assert.equal(s.verifyCalls.length, 0);
  assert.equal(s.relayer._state.holds.size, 0);
  // A closed batch's bind no longer admits payloads.
  await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs() }).hex, quoteId: q.quoteId });
  await s.relayer.flush();
  await assert.rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs() }).hex }), (e) => e.status === 409);
});

test('draining: a batch past closesAt takes no new quotes but waits for its outstanding quotes, bounded by their expiry', async () => {
  const s = await setup({ quoteTtlMs: 300_000 });
  const q = await s.relayer.quote({ asset: ASSET });
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs }).hex, quoteId: q.quoteId });
  const late = await s.relayer.quote({ asset: ASSET });
  s.advance(61_000);
  await s.relayer.tick();
  assert.equal(s.broadcasts.length, 0, 'the unused quote holds the batch open');
  assert.equal(s.relayer._state.draining.length, 1);
  const fresh = await s.relayer.quote({ asset: ASSET });
  assert.notDeepEqual(fresh.bind, q.bind, 'new quotes open the next batch');
  assert.notEqual(fresh.batchId, q.batchId);
  // The slow sender (proving took minutes) still lands in the draining batch.
  s.advance(120_000);
  const r = await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, bind: late.bind }).hex, quoteId: late.quoteId });
  assert.equal(r.batchId, late.batchId);
  await s.relayer.tick();
  const [c] = s.relayer._state.carriers;
  assert.equal(c.state, 'broadcast');
  assert.equal(c.id, q.batchId);
  assert.equal(txOf(c.revealHex).vin.length, 3, 'two envelopes and the bind');
  assert.ok(sameOp(txOf(c.revealHex).vin[2], q.bind));
  // A quote left unused past its expiry does not hold the next batch forever.
  const t = await setup({ quoteTtlMs: 100_000 });
  await t.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs }).hex });
  await t.relayer.quote({ asset: ASSET });
  t.advance(61_000); await t.relayer.tick();
  assert.equal(t.broadcasts.length, 0);
  t.advance(40_000); await t.relayer.tick();
  assert.equal(t.relayer._state.carriers.length, 1);
  assert.equal(t.relayer._state.carriers[0].state, 'broadcast');
});

test('pay-only spend is accepted without a quote id at the configured fee', async () => {
  const s = await setup();
  const p = payloadFor({ notes: [ownedNote(50n)], outputs: [{ address: bob.addressString, value: 38n }, { address: relayerWallet.addressString, value: 12n }] });
  const r = await s.relayer.submit({ payload: p.hex });
  assert.equal(s.relayer.status(r.id).state, 'held');
});

test('underpaid fee is rejected', async () => {
  const s = await setup();
  const p = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: relayerWallet.addressString, value: 9n }, { address: bob.addressString, value: 91n }] });
  await rejects(s.relayer.submit({ payload: p.hex }), /below the quoted fee/);
  assert.equal(s.verifyCalls.length, 0);
  assert.equal(s.relayer._state.holds.size, 0);
});

test('fee note to the wrong key is rejected', async () => {
  const s = await setup();
  const p1 = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: eve.addressString, value: 10n }, { address: bob.addressString, value: 90n }] });
  await rejects(s.relayer.submit({ payload: p1.hex }), /no output is received/);
  // Decrypts under the relayer's viewing key, but spend_key / nk_pub come from another (A, N).
  const mixed = strip(relayerWallet.V) + strip(eve.A) + strip(eve.N);
  const mixedAddr = bp.encodeAddress('0x' + mixed, 'signet');
  const p2 = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: mixedAddr, value: 10n }, { address: bob.addressString, value: 90n }] });
  await rejects(s.relayer.submit({ payload: p2.hex }), /no output is received/);
  const mixedN = strip(relayerWallet.V) + strip(relayerWallet.A) + strip(eve.N);
  const p3 = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: bp.encodeAddress('0x' + mixedN, 'signet'), value: 10n }, { address: bob.addressString, value: 90n }] });
  await rejects(s.relayer.submit({ payload: p3.hex }), /no output is received/);
  assert.equal(s.verifyCalls.length, 0);
});

test('fee note whose leaf does not match its sealed opening is rejected', async () => {
  const s = await setup();
  const note = ownedNote(100n);
  assert.equal(note.nf, bp.nullifier(note.nkNote, note.leaf, note.leafIndex));
  const fee = bp.createNote(relayerWallet.addressString, ASSET, 10n);
  const other = bp.createNote(relayerWallet.addressString, ASSET, 500n);
  const change = bp.createNote(bob.addressString, ASSET, 90n);
  const env = (outputs) => bytesToHex(bp.assembleSpendEnvelope(bp.encodeSpendBody({ asset: ASSET, hAnchor: ANCHOR, bind: FIRST_BIND, nullifiers: [note.nf], outputs }), OK_PROOF));
  // Leaf of a 500-sat note under a ciphertext sealing 10.
  await rejects(s.relayer.submit({ payload: env([{ ...fee, leaf: other.leaf }, change]) }), /no output is received/);
  // Ciphertext of another note under this note's ephemeral key.
  await rejects(s.relayer.submit({ payload: env([{ ...fee, ctNote: other.ctNote }, change]) }), /no output is received/);
  // Note of another asset.
  const foreign = bp.createNote(relayerWallet.addressString, '0x' + 'cd'.repeat(32), 10n);
  await rejects(s.relayer.submit({ payload: env([foreign, change]) }), /no output is received/);
  assert.equal(s.verifyCalls.length, 0);
  // Control: the untouched note is received.
  await s.relayer.submit({ payload: env([fee, change]) });
});

test('proof that does not verify is rejected and releases its nullifiers', async () => {
  const s = await setup();
  const note = ownedNote(100n);
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  const bad = payloadFor({ notes: [note], outputs: outs, proof: BAD_PROOF });
  await rejects(s.relayer.submit({ payload: bad.hex }), /proof does not verify/);
  assert.equal(s.relayer._state.holds.size, 0);
  const good = payloadFor({ notes: [note], outputs: outs });
  await s.relayer.submit({ payload: good.hex });
});

test('verifier unavailable fails closed', async () => {
  const s = await setup();
  s.verifier.enabled = false;
  const p = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }] });
  await assert.rejects(s.relayer.submit({ payload: p.hex }), (e) => e.status === 503);
});

test('exit whose boundary does not verify is rejected before the proof check and frees its slot', async () => {
  const s = await setup();
  const spk = p2tr('exit-bd');
  const q = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) });
  const note = ownedNote(100n);
  const p = payloadFor({ notes: [note], outputs: [{ address: relayerWallet.addressString, value: 10n }], exit: { exitVout: q.exitVout, scriptPubKey: spk } });
  await rejects(s.relayer.submit({ payload: corruptBoundary(p.hex), quoteId: q.quoteId }), /exit boundary does not verify/);
  assert.equal(s.verifyCalls.length, 0);
  assert.equal(s.relayer._state.holds.size, 0);
  assert.equal(s.relayer._state.batch.slots.length, 0);
  // The quote is released with the slot; the intact payload is accepted under it.
  await s.relayer.submit({ payload: p.hex, quoteId: q.quoteId });
  const call = s.verifyCalls[0];
  assert.deepEqual(call.publics, bp.payloadPublics(p.hex, { root: '0x' + ANCHOR_ROOT }).publics);
  // root, body_hash, asset, nf×2, out_leaf×3, exit_C, dep_C
  assert.notDeepEqual(call.publics.slice(8, 10), ['0', '1'], 'exit commitment is the boundary point');
  assert.deepEqual(call.publics.slice(10), ['0', '1'], 'no deposit on a spend');
  assert.deepEqual(call.publics.slice(3, 5), [BigInt(note.nf).toString(), '0']);
});

test('duplicate nullifier across payloads, sequential and concurrent', async () => {
  const s = await setup();
  const note = ownedNote(100n);
  const a = payloadFor({ notes: [note], outputs: [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }] });
  const b = payloadFor({ notes: [note], outputs: [{ address: relayerWallet.addressString, value: 20n }, { address: eve.addressString, value: 80n }] });
  await s.relayer.submit({ payload: a.hex });
  await rejects(s.relayer.submit({ payload: b.hex }), /held by another pending payload/);

  const s2 = await setup();
  const n2 = ownedNote(100n), n3 = ownedNote(100n);
  const c = payloadFor({ notes: [n2], outputs: [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }] });
  const d = payloadFor({ notes: [n3, n2], outputs: [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 190n }] });
  const res = await Promise.allSettled([s2.relayer.submit({ payload: c.hex }), s2.relayer.submit({ payload: d.hex })]);
  assert.deepEqual(res.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(res.find((r) => r.status === 'rejected').reason.message, /held by another/);
});

test('nullifier already spent in the replayed set, or in the mempool, is rejected', async () => {
  const s = await setup();
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: outs });
  s.spent.add(a.nullifiers[0]);
  await rejects(s.relayer.submit({ payload: a.hex }), /already spent/);
  const b = payloadFor({ notes: [ownedNote(100n)], outputs: outs });
  s.mempoolNfs.set('12'.repeat(32), new Set([b.nullifiers[0]]));
  await rejects(s.relayer.submit({ payload: b.hex }), /mempool/);
});

test('stale or unknown anchor is rejected', async () => {
  const s = await setup();
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 860 }).hex }), /h_anchor too old/);
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 995 }).hex }), /no root retained/);
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 1001 }).hex }), /ahead of the replayed tip/);
  await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 990 }).hex });
});

test('exit binds a free slot at submit and must match its quoted script', async () => {
  const s = await setup();
  const spk = p2tr('exit-a');
  const q = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) });
  assert.equal(q.exitVout, 0);
  const outs = [{ address: relayerWallet.addressString, value: 10n }];
  const wrongVout = payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: 1, scriptPubKey: spk } });
  await assert.rejects(s.relayer.submit({ payload: wrongVout.hex, quoteId: q.quoteId }), (e) => { assert.match(e.message, /not free/); assert.equal(e.extra.exitVout, 0); return true; });
  const wrongSpk = payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: 0, scriptPubKey: p2tr('other') } });
  await rejects(s.relayer.submit({ payload: wrongSpk.hex, quoteId: q.quoteId }), /dest_spk_hash/);
  const noQuote = payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: 0, scriptPubKey: spk } });
  await rejects(s.relayer.submit({ payload: noQuote.hex }), /needs a quote/);
  await s.relayer.submit({ payload: noQuote.hex, quoteId: q.quoteId });
  await rejects(s.relayer.submit({ payload: noQuote.hex, quoteId: q.quoteId }), /already used/);
  await rejects(s.relayer.quote({ asset: ASSET, exitScriptPubKey: '6a' }), /standard/);
  await rejects(s.relayer.quote({ asset: '0x' + '01'.repeat(32) }), /not relayed/);
});

test('batched carrier: one envelope input per payload, signed script-path spends', async () => {
  const s = await setup();
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: outs });
  const b = payloadFor({ notes: [ownedNote(100n)], outputs: outs });
  const ra = await s.relayer.submit({ payload: a.hex });
  const rb = await s.relayer.submit({ payload: b.hex });
  const c = await s.relayer.flush();
  assert.equal(c.state, 'broadcast');
  assert.equal(s.broadcasts.length, 2);
  const commit = parseTx(hexToBytes(s.broadcasts[0])).tx;
  const reveal = parseTx(hexToBytes(s.broadcasts[1])).tx;
  assert.equal(commit.txid, c.commitTxid);
  assert.equal(reveal.txid, c.revealTxid);
  const { prims } = makeBtcWallet({ priv: BTC_KEY, hrp: 'tb' });
  const relayerSpk = prims.p2wpkhScript(prims.wallet.pub);
  assert.equal(reveal.vin.length, 3);
  reveal.vin.slice(0, 2).forEach((i, k) => { assert.equal(i.txid, commit.txid); assert.equal(i.vout, k); });
  assert.deepEqual({ txid: reveal.vin[2].txid, vout: reveal.vin[2].vout }, FIRST_BIND, 'the carrier spends the bind');
  assert.deepEqual(reveal.vin[2].witness[1], prims.wallet.pub);
  assert.ok(!commit.vin.some((i) => i.txid === FIRST_BIND.txid && i.vout === FIRST_BIND.vout), 'the commit never spends the bind');
  assert.deepEqual(reveal.vout.map((o) => [bytesToHex(o.scriptPubKey), o.value]), [[bytesToHex(relayerSpk), 20_000n]], 'no exits: the bind returns to the relayer');
  const seen = [...spendNullifiersOfTx(reveal)].sort();
  assert.deepEqual(seen, [...a.nullifiers, ...b.nullifiers].sort());
  // Each reveal input signs under the envelope key over its own script-path sighash.
  const xonly = secp.getPublicKey(BTC_KEY, true).slice(1);
  const prevouts = [...commit.vout.slice(0, 2).map((o) => ({ value: Number(o.value), script: o.scriptPubKey })), { value: 20_000, script: relayerSpk }];
  const tx = { version: 2, locktime: 0, inputs: reveal.vin.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 0xfffffffd })), outputs: reveal.vout.map((o) => ({ value: Number(o.value), script: o.scriptPubKey })) };
  reveal.vin.slice(0, 2).forEach((i, k) => {
    const leaf = prims.tapLeafHash(i.witness[1]);
    assert.ok(bp.schnorrVerify(i.witness[0], tapScriptSighash(tx, k, prevouts, leaf), xonly), `input ${k} signature`);
  });
  // Reveal fee covers its vsize at the quoted rate (2 sat/vB).
  const raw = hexToBytes(s.broadcasts[1]);
  let wit = 2; for (const i of reveal.vin) wit += 1 + i.witness.reduce((x, w) => x + 1 + (w.length >= 0xfd ? 2 : 0) + w.length, 0);
  const vsize = Math.ceil(((raw.length - wit) * 4 + wit) / 4);
  const revealFee = prevouts.reduce((x, p) => x + p.value, 0) - tx.outputs.reduce((x, o) => x + o.value, 0);
  assert.ok(revealFee >= vsize * 2 && revealFee < vsize * 2 + 50, `reveal fee ${revealFee} for ${vsize} vB`);
  assert.equal(s.relayer.status(ra.id).state, 'broadcast');
  assert.equal(s.relayer.status(rb.id).carrier, c.revealTxid);
  // Held until the carrier confirms and the replay passes it.
  const again = payloadFor({ notes: [ownedNote(100n)], outputs: outs, bind: await s.openBatch() });
  await s.relayer.submit({ payload: again.hex });
  await rejects(s.relayer.submit({ payload: a.hex }), /held by another/);
  s.statuses.set(c.revealTxid, { confirmed: true, block_height: 1001 });
  await s.relayer.tick();
  assert.equal(s.relayer.status(ra.id).state, 'broadcast', 'replay not yet at the confirming block');
  s.pool.t = 1001;
  for (const nf of [...a.nullifiers, ...b.nullifiers]) s.spent.add(nf);
  await s.relayer.tick();
  assert.equal(s.relayer.status(ra.id).state, 'confirmed');
  assert.equal(s.relayer.status(rb.id).state, 'confirmed');
  assert.ok(![...a.nullifiers, ...b.nullifiers].some((nf) => s.relayer._state.holds.has(nf)));
});

test('script-path sighash matches the dapp signer at input 0', () => {
  const { prims } = makeBtcWallet({ priv: BTC_KEY, hrp: 'tb' });
  const script = prims.encodeEnvelopeScript(prims.wallet.xonly(), Uint8Array.of(0x6d, 1, 2, 3));
  const leaf = prims.tapLeafHash(script);
  const { Q_xonly, parity } = prims.tweakedOutputKey(prims.TAP_NUMS, leaf);
  const spk = prims.p2trScript(Q_xonly);
  const tx = { version: 2, locktime: 0, inputs: [{ txid: '11'.repeat(32), vout: 0, sequence: 0xfffffffd }, { txid: '22'.repeat(32), vout: 3, sequence: 0xfffffffd }], outputs: [{ value: 600, script: p2wpkh('x') }] };
  const prevouts = [{ value: 1000, script: spk }, { value: 2000, script: p2wpkh('y') }];
  const [sig] = prims.signTaprootScriptPathInput(tx, prevouts, script, prims.controlBlock(prims.TAP_NUMS, parity));
  assert.ok(bp.schnorrVerify(sig, tapScriptSighash(tx, 0, prevouts, leaf), prims.wallet.xonly()));
});

test('layout stays fixed when a sender drops out: its slot pays the relayer', async () => {
  const s = await setup();
  const [sa, sb, sc, sd] = ['a', 'b', 'c', 'd'].map((t) => p2tr('exit-' + t));
  const outs = [{ address: relayerWallet.addressString, value: 10n }];
  const bind = async (spk, vout) => {
    const q = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) });
    assert.equal(q.exitVout, vout);
    const p = payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: q.exitVout, scriptPubKey: spk } });
    return [p, await s.relayer.submit({ payload: p.hex, quoteId: q.quoteId })];
  };
  const [pa, ra] = await bind(sa, 0);
  const [pb, rb] = await bind(sb, 1);
  const [pc, rc] = await bind(sc, 2);
  const [pd, rd] = await bind(sd, 3);
  assert.equal(new Set([ra, rb, rc, rd].map((r) => r.batchId)).size, 1);
  // b and d are spent elsewhere before the carrier is built.
  s.spent.add(pb.nullifiers[0]);
  s.spent.add(pd.nullifiers[0]);
  s.advance(61_000);
  await s.relayer.tick();
  assert.equal(s.relayer.status(rb.id).state, 'dropped');
  assert.equal(s.relayer.status(rd.id).state, 'dropped');
  assert.equal(s.relayer.status(ra.id).state, 'broadcast');
  const reveal = parseTx(hexToBytes(s.broadcasts[1])).tx;
  assert.equal(reveal.vin.length, 3);
  const { prims } = makeBtcWallet({ priv: BTC_KEY, hrp: 'tb' });
  const relayerSpk = bytesToHex(prims.p2wpkhScript(prims.wallet.pub));
  // Slot 1 (dropped) pays the relayer; trailing slot 3 (dropped) is trimmed; a and c keep their vouts; the
  // bind's value returns after them.
  assert.deepEqual(reveal.vout.map((o) => bytesToHex(o.scriptPubKey)), [bytesToHex(sa), relayerSpk, bytesToHex(sc), relayerSpk]);
  assert.ok(reveal.vout.slice(0, 3).every((o) => o.value === 546n));
  assert.equal(reveal.vout[3].value, 20_000n);
  for (const p of [pa, pc]) {
    assert.equal(bytesToHex(sha256(reveal.vout[p.exit.exitVout].scriptPubKey)), strip(p.exit.destSpkHash));
  }
  assert.equal(s.relayer.status(rc.id).carrier, reveal.txid);
  // The next carrier starts its slots from 0 again.
  const next = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(sb) });
  assert.equal(next.exitVout, 0);
  assert.notDeepEqual(next.bind, FIRST_BIND, 'the next carrier binds another coin');
});

test('carrier retries after a funding or broadcast failure, dropping payloads whose anchor expired', async () => {
  const s = await setup();
  const realUtxos = s.chain.utxos;
  s.chain.utxos = async () => [];
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 990 });
  const b = payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: ANCHOR });
  const ra = await s.relayer.submit({ payload: a.hex });
  const rb = await s.relayer.submit({ payload: b.hex });
  const c = await s.relayer.flush();
  assert.equal(c.state, 'building');
  assert.match(c.lastError, /funding short/);
  assert.equal(s.broadcasts.length, 0);
  s.chain.utxos = realUtxos;
  s.pool.t = 990 + 144 - 1; // anchor 990 no longer valid for the next block
  s.roots.set(990, 'bb'.repeat(32));
  await s.relayer.tick();
  assert.equal(s.relayer.status(ra.id).state, 'dropped');
  assert.match(s.relayer.status(ra.id).reason, /h_anchor/);
  assert.equal(s.relayer.status(rb.id).state, 'broadcast');
  assert.equal(parseTx(hexToBytes(s.broadcasts[1])).tx.vin.length, 2);
  assert.ok(!s.relayer._state.holds.has(a.nullifiers[0]));
});

test('HTTP: info, quote and submit routes, other paths fall through', async () => {
  const s = await setup();
  const server = createServer(s.relayer.wrap((req, res) => { res.writeHead(418); res.end(); }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const info = await (await fetch(base + '/btc-pool/relay/info')).json();
    assert.equal(info.address, relayerWallet.addressString);
    const q = await (await fetch(base + '/btc-pool/relay/quote', { method: 'POST', body: JSON.stringify({ asset: ASSET }) })).json();
    assert.deepEqual(q.bind, FIRST_BIND);
    const p = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: q.address, value: 10n }, { address: bob.addressString, value: 90n }], bind: q.bind });
    const ok = await fetch(base + '/btc-pool/relay/submit', { method: 'POST', body: JSON.stringify({ payload: p.hex, quoteId: q.quoteId }) });
    assert.equal(ok.status, 200);
    const { id } = await ok.json();
    assert.equal((await (await fetch(base + `/btc-pool/relay/status/${id}`)).json()).state, 'held');
    const dup = await fetch(base + '/btc-pool/relay/submit', { method: 'POST', body: JSON.stringify({ payload: p.hex }) });
    assert.equal(dup.status, 400);
    assert.match((await dup.json()).error, /held/);
    assert.equal((await fetch(base + '/btc-pool/status')).status, 418);
  } finally { server.close(); }
});

test('fee config parsing', () => {
  const a = '0x' + '11'.repeat(32), b = '22'.repeat(32);
  assert.deepEqual([...parseFees(`${a}:5,${b}:7`)], [['11'.repeat(32), 5n], [b, 7n]]);
  assert.deepEqual([...parseFees(JSON.stringify({ [a]: '9' }))], [['11'.repeat(32), 9n]]);
  assert.throws(() => parseFees('xyz:1'), /bad asset/);
});

// ── admission bounds ──
const payOuts = () => [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
const settle = () => new Promise((r) => setTimeout(r, 1));

test('flood: in-flight proof checks count toward maxPending and run at most maxVerify at a time', async () => {
  const s = await setup({ maxPending: 4, maxVerify: 2 });
  let active = 0, peak = 0;
  const gates = [];
  s.verifier.verify = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => gates.push(r)); active--; return true; };
  const ps = Array.from({ length: 6 }, () => payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() }));
  const results = ps.map((p) => s.relayer.submit({ payload: p.hex }).then(() => 'ok', (e) => e.message));
  await settle();
  assert.equal(s.relayer.info().pending, 4);
  assert.equal(s.relayer._state.verifyActive(), 2);
  while (gates.length || active) { gates.shift()?.(); await settle(); }
  const out = await Promise.all(results);
  assert.equal(peak, 2);
  assert.equal(out.filter((r) => r === 'ok').length, 4);
  assert.equal(out.filter((r) => /busy/.test(r)).length, 2);
});

test('rate limit: per-client token bucket on /quote and /submit, keyed by the proxy-appended x-forwarded-for hop', async () => {
  const s = await setup({ rateLimit: { perMin: 1, burst: 2 } });
  const server = createServer(s.relayer.wrap((req, res) => { res.writeHead(418); res.end(); }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const q = (ip) => fetch(base + '/btc-pool/relay/quote', { method: 'POST', headers: { 'x-forwarded-for': `${Math.random()}, ${ip}` }, body: JSON.stringify({ asset: ASSET }) });
  try {
    assert.equal((await q('1.1.1.1')).status, 200);
    assert.equal((await q('1.1.1.1')).status, 200);
    assert.equal((await q('1.1.1.1')).status, 429);
    assert.equal((await q('2.2.2.2')).status, 200);
    const sub = (ip) => fetch(base + '/btc-pool/relay/submit', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: '{}' });
    assert.equal((await sub('3.3.3.3')).status, 400);
    assert.equal((await sub('3.3.3.3')).status, 400);
    assert.equal((await sub('3.3.3.3')).status, 429);
    assert.equal((await fetch(base + '/btc-pool/relay/info')).status, 200);
    s.advance(60_000);
    assert.equal((await q('1.1.1.1')).status, 200);
  } finally { server.close(); }
});

test('slot squatting: quotes bind no slot and reserve one coin per batch, are capped per client and globally; submit binds or names the free vout', async () => {
  const s = await setup({ maxQuotes: 20, maxQuotesPerClient: 3 }, { open: false });
  const spk = p2tr('exit-q');
  for (let i = 0; i < 10; i++) assert.equal((await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) }, 'x')).exitVout, 0);
  assert.equal(s.relayer._state.batch.slots.length, 0, 'no slot bound');
  assert.equal(s.relayer._state.reservedUtxos.size, 1, 'one coin for the batch, not one per quote');
  assert.equal([...s.relayer._state.quotes.values()].filter((q) => q.client === 'x').length, 3);
  for (let i = 0; i < 17; i++) await s.relayer.quote({ asset: ASSET }, 'c' + i);
  await assert.rejects(s.relayer.quote({ asset: ASSET }, 'late'), (e) => e.status === 503);
  s.advance(600_001);
  await s.relayer.quote({ asset: ASSET }, 'late');
  assert.equal(s.relayer._state.quotes.size, 1, 'expired quotes pruned on insert');

  // Two senders sign against the same provisional vout: the second is told the free one and re-signs.
  const outs = [{ address: relayerWallet.addressString, value: 10n }];
  const [s1, s2] = [p2tr('e1'), p2tr('e2')];
  const q1 = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(s1) });
  const q2 = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(s2) });
  assert.equal(q1.exitVout, 0); assert.equal(q2.exitVout, 0);
  await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: 0, scriptPubKey: s1 } }).hex, quoteId: q1.quoteId });
  const n2 = ownedNote(100n);
  let free;
  await assert.rejects(s.relayer.submit({ payload: payloadFor({ notes: [n2], outputs: outs, exit: { exitVout: 0, scriptPubKey: s2 } }).hex, quoteId: q2.quoteId }),
    (e) => { assert.equal(e.status, 409); free = e.extra.exitVout; return true; });
  assert.equal(free, 1);
  await s.relayer.submit({ payload: payloadFor({ notes: [n2], outputs: outs, exit: { exitVout: free, scriptPubKey: s2 } }).hex, quoteId: q2.quoteId });
  assert.equal(s.relayer._state.batch.slots.filter(Boolean).length, 2);
  // A failed proof check frees its slot.
  const q3 = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(p2tr('e3')) });
  assert.equal(q3.exitVout, 2);
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: 2, scriptPubKey: p2tr('e3') }, proof: BAD_PROOF }).hex, quoteId: q3.quoteId }), /does not verify/);
  assert.equal(s.relayer._state.batch.slots.length, 2);
});

// ── chain view ──
test('blind spot: nullifier spent in a block past the replayed tip is rejected at submit and before carrying', async () => {
  const s = await setup();
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
  s.pending.set(a.nullifiers[0], { txid: '55'.repeat(32), body: null });
  await rejects(s.relayer.submit({ payload: a.hex }), /recent block/);
  s.pool.complete = false;
  const b = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
  await assert.rejects(s.relayer.submit({ payload: b.hex }), (e) => e.status === 503);
  s.pool.complete = true;
  const rb = await s.relayer.submit({ payload: b.hex });
  s.pending.set(b.nullifiers[0], { txid: '56'.repeat(32), body: null });
  const c = await s.relayer.flush();
  assert.equal(c.state, 'empty');
  assert.equal(s.relayer.status(rb.id).state, 'dropped');
  assert.equal(s.broadcasts.length, 0);
});

const sha256d = (b) => sha256(sha256(b));
const le32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
function merkle(level) {
  while (level.length > 1) { const n = []; for (let i = 0; i < level.length; i += 2) n.push(sha256d(concatBytes(level[i], level[i + 1] || level[i]))); level = n; }
  return level[0];
}
function buildBlock(txHexes, nonce = 0) {
  const { prims } = makeBtcWallet({ priv: BTC_KEY, hrp: 'tb' });
  const txs = txHexes.map((h) => hexToBytes(h));
  const parsed = txs.map((b) => parseTx(b).tx);
  const reserved = new Uint8Array(32);
  const commit = sha256d(concatBytes(merkle([new Uint8Array(32), ...parsed.map((t) => t.wtxid || hexToBytes(t.txid).reverse())]), reserved));
  const cb = prims.serializeTx({ version: 2, locktime: 0, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, sequence: 0xffffffff, scriptSig: Uint8Array.of(1, nonce), witness: [reserved] }], outputs: [{ value: 0, script: concatBytes(Uint8Array.of(0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed), commit) }] });
  const root = merkle([parseTx(cb).tx, ...parsed].map((t) => hexToBytes(t.txid).reverse()));
  const header = concatBytes(le32(2), new Uint8Array(32), root, le32(nonce), le32(0x207fffff), le32(0));
  return { raw: concatBytes(header, Uint8Array.of(1 + txs.length), cb, ...txs), hash: bytesToHex(sha256d(header).reverse()) };
}

test('indexer tracks spends in blocks between the replayed tip and the chain tip', async () => {
  const s = await setup();
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
  await s.relayer.submit({ payload: a.hex });
  const c = await s.relayer.flush();
  const withSpend = buildBlock([c.revealHex], 1), empty = buildBlock([], 2);
  const chainBlocks = new Map([[100, empty], [101, withSpend]]);
  const esplora = {
    tipHeight: async () => 101,
    blockHash: async (h) => chainBlocks.get(h).hash,
    rawBlock: async (hash) => [...chainBlocks.values()].find((b) => b.hash === hash).raw,
  };
  const store = openBtcPoolStore(':memory:');
  const ix = createIndexer({ store, esplora, verifier: { enabled: true, verify: async () => true }, network: 'signet', startHeight: 100, confirmations: 3, log: () => {} });
  ix.trackAhead = spendsOfTx;
  const view = poolViewFromIndexer(ix);
  assert.equal(view.aheadComplete(), false);
  await ix.syncOnce();
  assert.equal(ix.state.tip, null, 'nothing confirmed deep enough to replay');
  assert.equal(view.aheadComplete(), true);
  assert.equal(view.chainTip(), 101);
  const hit = view.pendingSpend(a.nullifiers[0]);
  assert.equal(hit.txid, c.revealTxid);
  assert.equal(hit.body, bytesToHex(keccak_256(a.body)));
  // Reorged away: re-fetched and cleared.
  chainBlocks.set(101, buildBlock([], 3));
  await ix.syncOnce();
  assert.equal(view.pendingSpend(a.nullifiers[0]), null);
  store.close();
});

test('mempool sources: esplora skips an oversized mempool and backs off on 429; bitcoind RPC', async () => {
  const s = await setup();
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
  await s.relayer.submit({ payload: a.hex });
  const c = await s.relayer.flush();
  let t = 0, calls = [], mode = 'big';
  const res = (status, body) => ({ ok: status === 200, status, headers: new Headers(), text: async () => body });
  const fetchImpl = async (url) => {
    calls.push(url);
    if (mode === '429') return res(429, '');
    if (url.endsWith('/mempool/txids')) return res(200, JSON.stringify(mode === 'big' ? ['01'.repeat(32), '02'.repeat(32), '03'.repeat(32)] : [c.revealTxid]));
    return res(200, c.revealHex);
  };
  const w = makeMempoolWatch({ bases: ['http://x'], fetchImpl, maxTxids: 2, now: () => t });
  await w.refresh();
  assert.equal(calls.length, 1, 'no per-tx fetches for an oversized mempool');
  assert.equal(w.complete, false);
  mode = '429';
  await assert.rejects(w.refresh());
  calls = [];
  t += 10_000;
  await w.refresh();
  assert.equal(calls.length, 0, 'backing off');
  mode = 'ok';
  t += 30_000;
  await w.refresh();
  assert.equal(w.conflict(a.nullifiers), c.revealTxid);
  assert.equal(w.spender(a.nullifiers[0]).body, bytesToHex(keccak_256(a.body)));

  const rpcCalls = [];
  const rpc = makeBitcoindRpc({
    url: 'http://u:p@127.0.0.1:8332',
    fetchImpl: async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      rpcCalls.push([url, init.headers.Authorization, method]);
      const result = method === 'getrawmempool' ? [c.revealTxid] : method === 'getrawtransaction' && params[0] === c.revealTxid ? c.revealHex : null;
      return { status: 200, json: async () => ({ result, error: null }) };
    },
  });
  const m = makeBitcoindMempool({ rpc });
  await m.refresh();
  assert.equal(m.conflict(a.nullifiers), c.revealTxid);
  assert.equal(m.conflict(a.nullifiers, new Set([c.revealTxid])), null);
  assert.equal(rpcCalls[0][0], 'http://127.0.0.1:8332/');
  assert.equal(rpcCalls[0][1], 'Basic ' + Buffer.from('u:p').toString('base64'));
});

test('anchor freshness is measured from the chain tip with a margin', async () => {
  const s = await setup();
  s.pool.ct = 1010; // replay at 1000
  assert.equal(s.relayer.info().minAnchor, 1010 + 1 - 144 + 6);
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts(), hAnchor: 870 }).hex }), /too old/);
  await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts(), hAnchor: 875 }).hex });
  s.pool.ct = 1013;
  await assert.rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() }).hex }), (e) => e.status === 503 && /behind/.test(e.message));
  const t = await setup({ anchorMargin: 0 });
  t.pool.ct = 1010;
  await t.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts(), hAnchor: 870 }).hex });
});

const txOf = (hex) => parseTx(hexToBytes(hex)).tx;
const sameOp = (a, b) => a.txid === b.txid && a.vout === b.vout;
const inputsOf = (hex) => txOf(hex).vin.map((i) => `${i.txid}:${i.vout}`).sort();

test('carrier near anchor expiry is fee-bumped by replacing its commit, then returned to the relayer', async () => {
  const s = await setup();
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
  const ra = await s.relayer.submit({ payload: a.hex });
  const c = await s.relayer.flush();
  const first = { commit: c.commitHex, fee: c.commitFee + c.revealFee, rate: c.rate };
  s.statuses.set(c.commitTxid, { confirmed: false });
  s.statuses.set(c.revealTxid, { confirmed: false });
  await s.relayer.tick();
  assert.equal(c.commitHex, first.commit, 'not near expiry yet');
  s.pool.ct = ANCHOR + 144 - 3;
  await s.relayer.tick();
  assert.notEqual(c.commitHex, first.commit);
  assert.deepEqual(s.broadcasts.slice(-2), [c.commitHex, c.revealHex]);
  assert.deepEqual(inputsOf(c.commitHex), inputsOf(first.commit), 'replacement spends the same inputs');
  assert.ok(c.rate > first.rate);
  assert.ok(c.commitFee > first.fee, 'replacement pays more than commit + reveal it evicts');
  assert.equal(txOf(c.revealHex).vin[0].txid, c.commitTxid);
  assert.equal(s.relayer.status(ra.id).carrier, c.revealTxid);
  const bumped = c.commitHex;
  s.statuses.set(c.revealTxid, { confirmed: false });
  await s.relayer.tick();
  assert.equal(c.commitHex, bumped, 'one bump per block');
  s.pool.ct = ANCHOR + 144;
  await s.relayer.tick();
  const cancel = txOf(s.broadcasts.at(-1));
  assert.equal(c.state, 'cancelled');
  assert.deepEqual(inputsOf(s.broadcasts.at(-1)), inputsOf(first.commit));
  const { prims } = makeBtcWallet({ priv: BTC_KEY, hrp: 'tb' });
  assert.deepEqual(cancel.vout.map((o) => bytesToHex(o.scriptPubKey)), [bytesToHex(prims.p2wpkhScript(prims.wallet.pub))]);
  assert.equal(s.relayer.status(ra.id).state, 'dropped');
  assert.ok(!s.relayer._state.holds.has(a.nullifiers[0]));

  // At maxFeeRate there is no bump left: cancel.
  const t = await setup({ maxFeeRate: 2 });
  const rb = await t.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() }).hex });
  const cb = await t.relayer.flush();
  t.pool.ct = ANCHOR + 144 - 2;
  await t.relayer.tick();
  assert.equal(cb.state, 'cancelled');
  assert.equal(t.relayer.status(rb.id).state, 'dropped');
});

test('foreign spend of a carried nullifier: payload leaves the carrier, commit replaced or returned', async () => {
  const s = await setup();
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
  const b = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
  const ra = await s.relayer.submit({ payload: a.hex });
  const rb = await s.relayer.submit({ payload: b.hex });
  const c = await s.relayer.flush();
  const firstCommit = c.commitHex, firstReveal = c.revealTxid;
  s.pending.set(a.nullifiers[0], { txid: '77'.repeat(32), body: bytesToHex(keccak_256(a.body)) });
  await s.relayer.tick();
  const sa = s.relayer.status(ra.id);
  assert.equal(sa.state, 'replayed-elsewhere');
  assert.equal(sa.foreignTxid, '77'.repeat(32));
  assert.equal(sa.feeViaForeign, true);
  assert.ok(!s.relayer._state.holds.has(a.nullifiers[0]));
  assert.deepEqual(inputsOf(c.commitHex), inputsOf(firstCommit));
  assert.equal(txOf(c.revealHex).vin.length, 2);
  assert.deepEqual([...spendNullifiersOfTx(txOf(c.revealHex))], b.nullifiers);
  assert.equal(s.relayer.status(rb.id).carrier, c.revealTxid);
  // The replaced reveal is still recognized as the relayer's own.
  s.mempoolNfs.set(firstReveal, new Set(b.nullifiers));
  await s.relayer.tick();
  assert.equal(s.relayer.status(rb.id).state, 'broadcast');
  s.mempoolNfs.set('88'.repeat(32), new Set(b.nullifiers));
  await s.relayer.tick();
  assert.equal(s.relayer.status(rb.id).state, 'replayed-elsewhere');
  assert.equal(s.relayer.status(rb.id).feeViaForeign, null);
  assert.equal(c.state, 'cancelled');
  assert.equal(txOf(s.broadcasts.at(-1)).vout.length, 1);

  // Commit already confirmed: nothing to replace, payload still marked.
  const t = await setup();
  const d = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
  const rd = await t.relayer.submit({ payload: d.hex });
  const cd = await t.relayer.flush();
  t.statuses.set(cd.commitTxid, { confirmed: true, block_height: 1001 });
  t.pending.set(d.nullifiers[0], { txid: '99'.repeat(32), body: null });
  const n = t.broadcasts.length;
  await t.relayer.tick();
  assert.equal(t.relayer.status(rd.id).state, 'replayed-elsewhere');
  assert.equal(t.broadcasts.length, n);
});

// ── broadcast ──
test('ambiguous broadcast: identical bytes are rebroadcast; a landed commit is not rebuilt', async () => {
  const s = await setup();
  await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() }).hex });
  s.failQueue.push('lost');
  const c = await s.relayer.flush();
  assert.equal(c.state, 'signed');
  const commit = c.commitHex;
  await s.relayer.tick();
  assert.equal(c.state, 'broadcast');
  assert.deepEqual(s.attempts, [commit, commit, c.revealHex]);

  const t = await setup();
  await t.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() }).hex });
  t.failQueue.push('landed');
  const d = await t.relayer.flush();
  assert.equal(d.state, 'broadcast');
  assert.equal(t.attempts.length, 2);
  t.failQueue.push(undefined, 'lost');
  const bindE = await t.openBatch();
  const e = await (async () => { await t.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts(), bind: bindE }).hex }); return t.relayer.flush(); })();
  assert.equal(e.state, 'committed');
  const revealE = e.revealHex;
  await t.relayer.tick();
  assert.equal(e.state, 'broadcast');
  assert.equal(t.attempts.at(-1), revealE);

  // Rebuilt only when absent, inputs unspent, and an identical rebroadcast also failed; on the same inputs.
  const u = await setup();
  const spends = [];
  u.chain.outspend = async (txid, vout) => { spends.push(`${txid}:${vout}`); return { spent: false }; };
  await u.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() }).hex });
  u.failQueue.push('lost', 'lost');
  const f = await u.relayer.flush();
  assert.equal(f.state, 'signed');
  assert.equal(spends.length, 0, 'first failure never rebuilds');
  const firstCommit = f.commitHex;
  await u.relayer.tick();
  assert.equal(f.state, 'building');
  await u.relayer.tick();
  assert.equal(f.state, 'broadcast');
  assert.deepEqual(inputsOf(f.commitHex), inputsOf(firstCommit));
});

test('dust: 546-sat coins fund a carrier', async () => {
  const s = await setup();
  s.chain.utxos = async () => Array.from({ length: 30 }, (_, i) => ({ txid: (i + 16).toString(16).padStart(2, '0').repeat(32), vout: 0, value: 546 }));
  await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() }).hex });
  const c = await s.relayer.flush();
  assert.equal(c.state, 'broadcast', c.lastError);
  assert.ok(c.picked.every((u) => u.value === 546));
});

// ── persistence ──
test('restart resumes carriers, held payloads, slots and nullifier holds from the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'btc-pool-relay-'));
  const path = join(dir, 'pool.db');
  try {
    const store = openBtcPoolStore(path);
    const s = await setup({ persist: store.relay });
    const a = payloadFor({ notes: [ownedNote(100n)], outputs: payOuts() });
    const ra = await s.relayer.submit({ payload: a.hex });
    const spk = p2tr('exit-r');
    const q = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) });
    const b = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: relayerWallet.addressString, value: 10n }], exit: { exitVout: q.exitVout, scriptPubKey: spk } });
    const rb = await s.relayer.submit({ payload: b.hex, quoteId: q.quoteId });
    s.failQueue.push('lost');
    const c = await s.relayer.flush();
    assert.equal(c.state, 'signed');
    const signedCommit = c.commitHex, signedReveal = c.revealHex;
    const q2 = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) });
    const d = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: relayerWallet.addressString, value: 10n }], exit: { exitVout: q2.exitVout, scriptPubKey: spk }, bind: q2.bind });
    const rd = await s.relayer.submit({ payload: d.hex, quoteId: q2.quoteId });
    store.close();

    const store2 = openBtcPoolStore(path);
    const r = await setup({ persist: store2.relay });
    assert.equal(r.relayer.status(ra.id).state, 'carried');
    assert.equal(r.relayer.status(rb.id).state, 'carried');
    assert.equal(r.relayer.status(rd.id).state, 'held');
    for (const nf of [...a.nullifiers, ...b.nullifiers, ...d.nullifiers]) assert.ok(r.relayer._state.holds.has(nf));
    await rejects(r.relayer.submit({ payload: a.hex }), /held by another/);
    assert.equal(r.relayer._state.draining[0].slots[0].payloadId, rd.id, 'held exit keeps its slot');
    assert.deepEqual(r.relayer._state.draining[0].bind, { ...q2.bind, value: 25_000 }, 'held payloads regroup under their bind');
      const nq = await r.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) });
    assert.equal(nq.exitVout, 0, 'new quotes go to a new batch');
    assert.notDeepEqual(nq.bind, r.relayer._state.draining[0].bind);
    assert.ok(!sameOp(nq.bind, FIRST_BIND), 'the resumed carrier keeps its bind reserved');
    await r.relayer.tick();
    const ic = r.attempts.indexOf(signedCommit), ir = r.attempts.indexOf(signedReveal);
    assert.ok(ic >= 0 && ir > ic, 'resumed with the stored bytes');
    assert.equal(r.relayer.status(ra.id).state, 'broadcast');
    const rc = r.relayer._state.carriers[0];
    const reveal = txOf(rc.revealHex);
    assert.equal(bytesToHex(reveal.vout[0].scriptPubKey), bytesToHex(spk));
    store2.close();

    // Replay tables are untouched by relayer state, and a replay rescan leaves relayer state alone.
    const store3 = openBtcPoolStore(path);
    store3.wipe();
    assert.ok(store3.relay.load().carriers.length >= 1);
    store3.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── real proofs: spend.circom proved in process, verified natively against the pinned key ──
// Two notes in a real Poseidon tree; a fee-paying pay and a fee-paying exit, both bound to FIRST_BIND (the bind
// of a fresh setup) with exit_vout 0 (its first free slot). Proved once per run.
const REAL_EXIT_SPK = p2tr('exit-real');
let realCache = null;
async function realCases() {
  if (realCache) return realCache;
  const pinDir = DEFAULT_PIN_PATH.replace(/pin\.json$/, '');
  const pin = JSON.parse(readFileSync(DEFAULT_PIN_PATH, 'utf8'));
  const system = makeGroth16System({
    vk: JSON.parse(readFileSync(pinDir + pin.vk, 'utf8')), wasm: readFileSync(pinDir + pin.wasm), zkey: readFileSync(pinDir + pin.zkey),
    snarkjs, pinnedVkHash: pin.vk_hash,
  });
  const tree = new PoseidonTree();
  for (let i = 0; i < 5; i++) tree.append(bp.createNote(eve.addressString, ASSET, 7n).leaf);
  const mine = [120n, 100n].map((v) => {
    const n = bp.createNote(alice.addressString, ASSET, v);
    return bp.tryReceive(alice, { ...n, leafIndex: tree.append(n.leaf) });
  });
  const root = tree.root();
  const withPath = (n) => ({ ...n, path: tree.rootAndPath(n.leafIndex).path });
  const t0 = performance.now();
  const payB = bp.buildSpendBody({ asset: ASSET, hAnchor: ANCHOR, root, bind: FIRST_BIND, inputs: [withPath(mine[0])], outputs: [{ address: relayerWallet.addressString, value: 12n }, { address: bob.addressString, value: 108n }] });
  const pay = await bp.prove(payB, system);
  const exitB = bp.buildSpendBody({ asset: ASSET, hAnchor: ANCHOR, root, bind: FIRST_BIND, inputs: [withPath(mine[1])], outputs: [{ address: relayerWallet.addressString, value: 10n }], exit: { exitVout: 0, scriptPubKey: REAL_EXIT_SPK } });
  const exit = await bp.prove(exitB, system);
  realCache = {
    root: bytesToHex(root), notes: mine,
    pay: { hex: bytesToHex(pay.payload), nullifiers: payB.nullifiers.map(strip), proof: pay.proof },
    exit: { hex: bytesToHex(exit.payload), nullifiers: exitB.nullifiers.map(strip), proof: exit.proof },
    ms: performance.now() - t0,
  };
  console.log(`    (proved 2 spends in ${(realCache.ms / 1000).toFixed(1)} s)`);
  return realCache;
}
async function realSetup() {
  const r = await realCases();
  const native = makeBtcPoolVerifier({ network: 'signet', env: {}, log: () => {} });
  assert.equal(native.enabled, true, native.reason);
  const calls = [];
  const verifier = { enabled: true, verify: async (x) => { const ok = await native.verify(x); calls.push({ ...x, ok }); return ok; } };
  const s = await setup({ verifier });
  s.roots.set(ANCHOR, r.root);
  return { s, r, calls };
}

test('real proof: a fee-paying spend is accepted by the native verifier and carried', async () => {
  const { s, r, calls } = await realSetup();
  const q = await s.relayer.quote({ asset: ASSET });
  assert.deepEqual(q.bind, FIRST_BIND);
  const res = await s.relayer.submit({ payload: r.pay.hex, quoteId: q.quoteId });
  assert.equal(s.relayer.status(res.id).state, 'held');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ok, true);
  assert.deepEqual(calls[0].publics, bp.payloadPublics(r.pay.hex, { root: '0x' + r.root }).publics);
  assert.equal(bytesToHex(calls[0].proof), bytesToHex(r.pay.proof));
  assert.equal(s.relayer._state.payloads.get(res.id).fee, 12n);
  const c = await s.relayer.flush();
  assert.equal(c.state, 'broadcast');
  assert.deepEqual([...spendNullifiersOfTx(txOf(c.revealHex))], r.pay.nullifiers);
});

test('real proof: tampered proof, another root, or a proof of another body is rejected', async () => {
  const { s, r, calls } = await realSetup();
  const bytes = hexToBytes(r.pay.hex);
  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 1 - 100] ^= 1;
  await rejects(s.relayer.submit({ payload: bytesToHex(tampered) }), /proof does not verify/);
  assert.equal(s.relayer._state.holds.size, 0);
  // The proof of the exit spliced onto the pay body.
  const pay = bp.parseSpend(bytes, { full: true });
  const spliced = bp.assembleSpendEnvelope(pay.body, r.exit.proof);
  await rejects(s.relayer.submit({ payload: bytesToHex(spliced) }), /proof does not verify/);
  // The replayed root at h_anchor differs from the one proved against.
  s.roots.set(ANCHOR, '0d'.repeat(32));
  await rejects(s.relayer.submit({ payload: r.pay.hex }), /proof does not verify/);
  assert.ok(calls.length === 3 && calls.every((x) => x.ok === false));
  s.roots.set(ANCHOR, r.root);
  await s.relayer.submit({ payload: r.pay.hex });
});

test('real proof: an exit is accepted under its quote; with its boundary corrupted it is rejected', async () => {
  const { s, r, calls } = await realSetup();
  const q = await s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(REAL_EXIT_SPK) });
  assert.equal(q.exitVout, 0);
  await rejects(s.relayer.submit({ payload: corruptBoundary(r.exit.hex), quoteId: q.quoteId }), /exit boundary does not verify/);
  assert.equal(calls.length, 0);
  const res = await s.relayer.submit({ payload: r.exit.hex, quoteId: q.quoteId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ok, true);
  assert.equal(s.relayer._state.payloads.get(res.id).fee, 10n);
  const c = await s.relayer.flush();
  const reveal = txOf(c.revealHex);
  assert.equal(bytesToHex(reveal.vout[0].scriptPubKey), bytesToHex(REAL_EXIT_SPK));
  assert.equal(reveal.vout[0].value, 546n);
  // The exit's opening is recoverable from the payload and the wallet's notes.
  const rec = bp.recoverExit(alice, hexToBytes(r.exit.hex), r.notes);
  assert.equal(rec.value, 90n);
});

let passed = 0;
const t0 = performance.now();
for (const [n, f] of tests) {
  try { await f(); passed++; console.log('  ok -', n); } catch (e) { console.error('  FAIL -', n); console.error(e); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
// snarkjs keeps worker threads alive after proving.
process.exit(process.exitCode ?? 0);
