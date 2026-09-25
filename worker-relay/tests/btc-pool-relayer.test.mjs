// Shielded-pool relayer (DESIGN-btc-shielded-pool.md §6) with mocked pool view, verifier, chain and mempool.
//   node tests/btc-pool-relayer.test.mjs   (from worker-relay/)

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { secp, sha256, keccak_256, hexToBytes, bytesToHex, concatBytes } from '../../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../../dapp/btc-shielded-pool.js';
import { makeBtcWallet } from '../../dapp/bitcoin-taproot-wallet.js';
import { parseTx } from '../src/lib/btc-pool-chain.js';
import { createRelayer, tapScriptSighash, spendNullifiersOfTx, parseFees, spendPublicValues } from '../src/lib/btc-pool-relayer.js';

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
  assert.ok(r && r.nf);
  return r;
}
// Proof byte 0x01 verifies under the mock verifier; anything else does not.
function payloadFor({ notes, outputs, exit = null, hAnchor = ANCHOR, proof = Uint8Array.of(1, 2, 3) }) {
  const b = bp.buildSpendBody({ asset: ASSET, hAnchor, inputs: notes, outputs, exit });
  return { hex: bytesToHex(bp.assembleSpendEnvelope(b.body, proof)), nullifiers: b.nullifiers.map(strip), body: b.body, exit: b.exit };
}

function setup(over = {}) {
  const roots = new Map([[ANCHOR, 'aa'.repeat(32)], [990, 'bb'.repeat(32)], [860, 'cc'.repeat(32)]]);
  const spent = new Set();
  const pool = { t: TIP, tip() { return this.t; }, rootAt: (h) => roots.get(h) || null, isSpent: (nf) => spent.has(strip(nf)) };
  const verifyCalls = [];
  const verifier = {
    enabled: true,
    verify: async ({ proof, publicValues }) => {
      verifyCalls.push({ proof, publicValues });
      await new Promise((r) => setTimeout(r, 5));
      return proof[0] === 1;
    },
  };
  const broadcasts = [];
  const statuses = new Map();
  const chain = {
    utxos: async () => [{ txid: 'ee'.repeat(32), vout: 1, value: 200_000 }, { txid: 'dd'.repeat(32), vout: 0, value: 50_000 }],
    feeRate: async () => 2,
    broadcast: async (hex) => { broadcasts.push(hex); return 'ok'; },
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
  return { relayer, pool, roots, spent, verifier, verifyCalls, chain, broadcasts, statuses, mempoolNfs, advance: (ms) => { clock += ms; } };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('relayer address is the pool wallet derived from its seed', () => {
  const { relayer } = setup();
  assert.equal(relayer.address, relayerWallet.addressString);
  assert.match(relayer.fundAddress, /^tb1q/);
  assert.equal(relayer.info().fees[ASSET], '10');
});

test('accept: fee note fully received, proof checked against the replayed root', async () => {
  const s = setup();
  const q = s.relayer.quote({ asset: ASSET });
  assert.equal(q.fee, '10');
  assert.equal(q.address, relayerWallet.addressString);
  assert.equal(q.exitVout, null);
  const p = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: q.address, value: 10n }, { address: bob.addressString, value: 90n }] });
  const r = await s.relayer.submit({ payload: p.hex, quoteId: q.quoteId });
  assert.equal(s.relayer.status(r.id).state, 'held');
  assert.equal(s.verifyCalls.length, 1);
  assert.equal(bytesToHex(s.verifyCalls[0].publicValues), bytesToHex(spendPublicValues('aa'.repeat(32), p.body)));
  for (const nf of p.nullifiers) assert.equal(s.relayer._state.holds.get(nf), r.id);
});

test('pay-only spend is accepted without a quote at the configured fee', async () => {
  const s = setup();
  const p = payloadFor({ notes: [ownedNote(50n)], outputs: [{ address: bob.addressString, value: 38n }, { address: relayerWallet.addressString, value: 12n }] });
  const r = await s.relayer.submit({ payload: p.hex });
  assert.equal(s.relayer.status(r.id).state, 'held');
});

test('underpaid fee is rejected', async () => {
  const s = setup();
  const p = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: relayerWallet.addressString, value: 9n }, { address: bob.addressString, value: 91n }] });
  await rejects(s.relayer.submit({ payload: p.hex }), /below the quoted fee/);
  assert.equal(s.verifyCalls.length, 0);
  assert.equal(s.relayer._state.holds.size, 0);
});

test('fee note to the wrong key is rejected', async () => {
  const s = setup();
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

test('fee note whose opening does not match (Cx, Cy) is rejected', async () => {
  const s = setup();
  const note = ownedNote(100n);
  const fee = bp.createNote(relayerWallet.addressString, ASSET, 10n);
  const other = bp.createNote(relayerWallet.addressString, ASSET, 500n);
  const forged = { ...fee, cx: other.cx, cy: other.cy };
  const change = bp.createNote(bob.addressString, ASSET, 90n);
  const body = bp.encodeSpendBody({ asset: ASSET, hAnchor: ANCHOR, nullifiers: [bp.nullifier(note.leaf, note.nkNote, note.leafIndex)], outputs: [forged, change] });
  const hex = bytesToHex(bp.assembleSpendEnvelope(body, Uint8Array.of(1)));
  await rejects(s.relayer.submit({ payload: hex }), /no output is received/);
  // Control: the untouched note is received.
  const ok = bp.encodeSpendBody({ asset: ASSET, hAnchor: ANCHOR, nullifiers: [bp.nullifier(note.leaf, note.nkNote, note.leafIndex)], outputs: [fee, change] });
  await s.relayer.submit({ payload: bytesToHex(bp.assembleSpendEnvelope(ok, Uint8Array.of(1))) });
});

test('proof that does not verify is rejected and releases its nullifiers', async () => {
  const s = setup();
  const note = ownedNote(100n);
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  const bad = payloadFor({ notes: [note], outputs: outs, proof: Uint8Array.of(9) });
  await rejects(s.relayer.submit({ payload: bad.hex }), /proof does not verify/);
  assert.equal(s.relayer._state.holds.size, 0);
  const good = payloadFor({ notes: [note], outputs: outs });
  await s.relayer.submit({ payload: good.hex });
});

test('verifier unavailable fails closed', async () => {
  const s = setup();
  s.verifier.enabled = false;
  const p = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }] });
  await assert.rejects(s.relayer.submit({ payload: p.hex }), (e) => e.status === 503);
});

test('duplicate nullifier across payloads, sequential and concurrent', async () => {
  const s = setup();
  const note = ownedNote(100n);
  const a = payloadFor({ notes: [note], outputs: [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }] });
  const b = payloadFor({ notes: [note], outputs: [{ address: relayerWallet.addressString, value: 20n }, { address: eve.addressString, value: 80n }] });
  await s.relayer.submit({ payload: a.hex });
  await rejects(s.relayer.submit({ payload: b.hex }), /held by another pending payload/);

  const s2 = setup();
  const n2 = ownedNote(100n), n3 = ownedNote(100n);
  const c = payloadFor({ notes: [n2], outputs: [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }] });
  const d = payloadFor({ notes: [n3, n2], outputs: [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 190n }] });
  const res = await Promise.allSettled([s2.relayer.submit({ payload: c.hex }), s2.relayer.submit({ payload: d.hex })]);
  assert.deepEqual(res.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(res.find((r) => r.status === 'rejected').reason.message, /held by another/);
});

test('nullifier already spent in the replayed set, or in the mempool, is rejected', async () => {
  const s = setup();
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  const a = payloadFor({ notes: [ownedNote(100n)], outputs: outs });
  s.spent.add(a.nullifiers[0]);
  await rejects(s.relayer.submit({ payload: a.hex }), /already spent/);
  const b = payloadFor({ notes: [ownedNote(100n)], outputs: outs });
  s.mempoolNfs.set('12'.repeat(32), new Set([b.nullifiers[0]]));
  await rejects(s.relayer.submit({ payload: b.hex }), /mempool/);
});

test('stale or unknown anchor is rejected', async () => {
  const s = setup();
  const outs = [{ address: relayerWallet.addressString, value: 10n }, { address: bob.addressString, value: 90n }];
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 860 }).hex }), /h_anchor too old/);
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 995 }).hex }), /no root retained/);
  await rejects(s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 1001 }).hex }), /ahead of the replayed tip/);
  await s.relayer.submit({ payload: payloadFor({ notes: [ownedNote(100n)], outputs: outs, hAnchor: 990 }).hex });
});

test('exit must use its quoted slot and script', async () => {
  const s = setup();
  const spk = p2tr('exit-a');
  const q = s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) });
  assert.equal(q.exitVout, 0);
  const outs = [{ address: relayerWallet.addressString, value: 10n }];
  const wrongVout = payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: 1, scriptPubKey: spk } });
  await rejects(s.relayer.submit({ payload: wrongVout.hex, quoteId: q.quoteId }), /assigned slot/);
  const wrongSpk = payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: 0, scriptPubKey: p2tr('other') } });
  await rejects(s.relayer.submit({ payload: wrongSpk.hex, quoteId: q.quoteId }), /dest_spk_hash/);
  const noQuote = payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: 0, scriptPubKey: spk } });
  await rejects(s.relayer.submit({ payload: noQuote.hex }), /needs a quote/);
  await s.relayer.submit({ payload: noQuote.hex, quoteId: q.quoteId });
  await rejects(s.relayer.submit({ payload: noQuote.hex, quoteId: q.quoteId }), /already used/);
  assert.throws(() => s.relayer.quote({ asset: ASSET, exitScriptPubKey: '6a' }), /standard/);
  assert.throws(() => s.relayer.quote({ asset: '0x' + '01'.repeat(32) }), /not relayed/);
});

test('batched carrier: one envelope input per payload, signed script-path spends', async () => {
  const s = setup();
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
  assert.equal(reveal.vin.length, 2);
  reveal.vin.forEach((i, k) => { assert.equal(i.txid, commit.txid); assert.equal(i.vout, k); });
  assert.deepEqual(reveal.vout.map((o) => bytesToHex(o.scriptPubKey)), ['6a'], 'no exits: single empty OP_RETURN');
  const seen = [...spendNullifiersOfTx(reveal)].sort();
  assert.deepEqual(seen, [...a.nullifiers, ...b.nullifiers].sort());
  // Each reveal input signs under the envelope key over its own script-path sighash.
  const xonly = secp.getPublicKey(BTC_KEY, true).slice(1);
  const prevouts = commit.vout.slice(0, 2).map((o) => ({ value: Number(o.value), script: o.scriptPubKey }));
  const tx = { version: 2, locktime: 0, inputs: reveal.vin.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 0xfffffffd })), outputs: reveal.vout.map((o) => ({ value: Number(o.value), script: o.scriptPubKey })) };
  const { prims } = makeBtcWallet({ priv: BTC_KEY, hrp: 'tb' });
  reveal.vin.forEach((i, k) => {
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
  const again = payloadFor({ notes: [ownedNote(100n)], outputs: outs });
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
  const s = setup();
  const [sa, sb, sc, sd] = ['a', 'b', 'c', 'd'].map((t) => p2tr('exit-' + t));
  const qa = s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(sa) });
  const qb = s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(sb) });
  const qc = s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(sc) });
  const qd = s.relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(sd) });
  assert.deepEqual([qa, qb, qc, qd].map((q) => q.exitVout), [0, 1, 2, 3]);
  assert.equal(new Set([qa, qb, qc, qd].map((q) => q.batchId)).size, 1);
  const outs = [{ address: relayerWallet.addressString, value: 10n }];
  const ex = (q, spk) => payloadFor({ notes: [ownedNote(100n)], outputs: outs, exit: { exitVout: q.exitVout, scriptPubKey: spk } });
  const pa = ex(qa, sa), pc = ex(qc, sc), pd = ex(qd, sd);
  const ra = await s.relayer.submit({ payload: pa.hex, quoteId: qa.quoteId });
  // qb never submits.
  const rc = await s.relayer.submit({ payload: pc.hex, quoteId: qc.quoteId });
  const rd = await s.relayer.submit({ payload: pd.hex, quoteId: qd.quoteId });
  // d's nullifier is spent elsewhere before the carrier is built.
  s.spent.add(pd.nullifiers[0]);
  s.advance(61_000);
  await s.relayer.tick();
  assert.equal(s.relayer.status(rd.id).state, 'dropped');
  assert.equal(s.relayer.status(ra.id).state, 'broadcast');
  const reveal = parseTx(hexToBytes(s.broadcasts[1])).tx;
  assert.equal(reveal.vin.length, 2);
  const { prims } = makeBtcWallet({ priv: BTC_KEY, hrp: 'tb' });
  const relayerSpk = bytesToHex(prims.p2wpkhScript(prims.wallet.pub));
  // Slot 1 (never submitted) pays the relayer; trailing slot 3 (dropped) is trimmed; a and c keep their vouts.
  assert.deepEqual(reveal.vout.map((o) => bytesToHex(o.scriptPubKey)), [bytesToHex(sa), relayerSpk, bytesToHex(sc)]);
  assert.ok(reveal.vout.every((o) => o.value === 546n));
  for (const p of [pa, pc]) {
    assert.equal(bytesToHex(sha256(reveal.vout[p.exit.exitVout].scriptPubKey)), strip(p.exit.destSpkHash));
  }
  // Quotes of a closed carrier are no longer accepted.
  const late = ex(qb, sb);
  await rejects(s.relayer.submit({ payload: late.hex, quoteId: qb.quoteId }), /unknown quote|expired/);
  assert.equal(s.relayer.status(rc.id).carrier, reveal.txid);
});

test('carrier retries after a funding or broadcast failure, dropping payloads whose anchor expired', async () => {
  const s = setup();
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
  assert.equal(parseTx(hexToBytes(s.broadcasts[1])).tx.vin.length, 1);
  assert.ok(!s.relayer._state.holds.has(a.nullifiers[0]));
});

test('HTTP: info, quote and submit routes, other paths fall through', async () => {
  const s = setup();
  const server = createServer(s.relayer.wrap((req, res) => { res.writeHead(418); res.end(); }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const info = await (await fetch(base + '/btc-pool/relay/info')).json();
    assert.equal(info.address, relayerWallet.addressString);
    const q = await (await fetch(base + '/btc-pool/relay/quote', { method: 'POST', body: JSON.stringify({ asset: ASSET }) })).json();
    const p = payloadFor({ notes: [ownedNote(100n)], outputs: [{ address: q.address, value: 10n }, { address: bob.addressString, value: 90n }] });
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

let passed = 0;
for (const [n, f] of tests) {
  try { await f(); passed++; console.log('  ok -', n); } catch (e) { console.error('  FAIL -', n); console.error(e); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} passed`);
