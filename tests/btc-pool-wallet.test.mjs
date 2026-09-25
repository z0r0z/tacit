// Wallet side of the Bitcoin-native shielded pool (DESIGN-btc-shielded-pool.md §2–§4). No network.
// Run: node tests/btc-pool-wallet.test.mjs
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { makeBtcShieldedPool, T_BTC_SHIELD, SHIELD_ENVELOPE_LEN } from '../dapp/btc-shielded-pool.js';
import { H as TACIT_H } from './bulletproofs.mjs';

const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
const Pt = secp.ProjectivePoint, G = Pt.BASE, N = secp.CURVE.n;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const big = (h) => BigInt('0x' + String(h).replace(/^0x/, ''));
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const te = new TextEncoder();

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET = '0x' + 'ab'.repeat(32);
const alice = pool.walletFromSeed(rnd(32), 'signet');
const bob = pool.walletFromSeed(rnd(32), 'signet');
const eve = pool.walletFromSeed(rnd(32), 'signet');

// ── generator and keys ──
assert.ok(pool.H.equals(TACIT_H));
ok('Pedersen H is the Tacit NUMS generator');

const seed = rnd(32);
const w1 = pool.walletFromSeed(seed), w2 = pool.walletFromSeed(seed);
assert.deepStrictEqual(w1, w2);
assert.notStrictEqual(w1.v, w1.a); assert.notStrictEqual(w1.a, w1.n); assert.notStrictEqual(w1.v, w1.n);
assert.strictEqual(unhex(w1.address).length, 99);
assert.ok(w1.addressString.startsWith('tbp1'));
assert.ok(pool.walletFromSeed(seed, 'mainnet').addressString.startsWith('bp1'));
const dec = pool.decodeAddress(w1.addressString);
assert.strictEqual('0x' + hex(dec.bytes), w1.address);
assert.strictEqual(dec.network, 'signet');
assert.throws(() => pool.decodeAddress(w1.addressString, 'mainnet'));
const flipped = w1.addressString.slice(0, -1) + (w1.addressString.endsWith('q') ? 'p' : 'q');
assert.throws(() => pool.decodeAddress(flipped));
ok('seed → (v, a, n) is deterministic and domain-separated; 99-byte address; bech32m tbp/bp round-trips, checksum enforced');

// ── Alice → Bob ──
const VALUE = 123_456_789n;
const note = pool.createNote(bob.addressString, ASSET, VALUE);
assert.strictEqual(unhex(note.pkEph).length, 33);
assert.strictEqual(unhex(note.nkPub).length, 33);
assert.strictEqual(unhex(note.spendKey).length, 32);
assert.strictEqual(unhex(note.ctNote).length, 56);
const expectLeaf = '0x' + hex(keccak_256(new Uint8Array([...unhex(ASSET), ...unhex(note.cx), ...unhex(note.cy), ...unhex(note.spendKey), ...unhex(note.nkPub), ...te.encode('tacit-btc-pool-note-v1')])));
assert.strictEqual(note.leaf, expectLeaf);
const pub = { asset: note.asset, cx: note.cx, cy: note.cy, spendKey: note.spendKey, nkPub: note.nkPub, pkEph: note.pkEph, ctNote: note.ctNote };

const got = pool.scan(bob, [{ ...pub, leafIndex: 5 }]);
assert.strictEqual(got.length, 1);
assert.strictEqual(got[0].value, VALUE);
assert.strictEqual(got[0].blinding, note.blinding);
assert.strictEqual(got[0].leaf, note.leaf);
const skSpend = big(got[0].skSpend), nkNote = big(got[0].nkNote);
assert.strictEqual(hex(G.multiply(skSpend).toRawBytes(true).slice(1)), note.spendKey.slice(2));
assert.strictEqual('0x' + hex(G.multiply(nkNote).toRawBytes(true)), note.nkPub);
assert.ok(nkNote > 0n && nkNote < N);
assert.strictEqual(got[0].nf, '0x' + hex(keccak_256(new Uint8Array([...te.encode('tacit-btc-pool-nf-v1'), ...unhex(note.leaf), ...unhex(got[0].nkNote), 0, 0, 0, 0, 0, 0, 0, 5]))));
const again = pool.scan(bob, [{ ...pub, leafIndex: 6 }, pub]);
assert.notStrictEqual(again[0].nf, got[0].nf);
assert.strictEqual(again[1].nf, undefined);
assert.strictEqual(again[1].nkNote, got[0].nkNote);
ok('Bob scans Alice\'s note: exact value and blinding, sk_spend opens spend_key, nk_note opens nk_pub, nf binds leaf_index');

assert.strictEqual(pool.scan(eve, [pub]).length, 0);
assert.strictEqual(pool.scan(alice, [pub]).length, 0);
ok('a third wallet (and the sender\'s own wallet) receives nothing');

// ── silent non-receipt ──
const tweak = (h, i) => { const b = unhex(h); b[i] ^= 1; return '0x' + hex(b); };
for (let i = 0; i < 56; i += 7) assert.strictEqual(pool.scan(bob, [{ ...pub, ctNote: tweak(pub.ctNote, i) }]).length, 0);
ok('tampered ct_note (any byte, ciphertext or tag) is not received');

const other = pool.commitXY(VALUE, 12345n);
assert.strictEqual(pool.scan(bob, [{ ...pub, cx: other.cx, cy: other.cy }]).length, 0);
const negC = Pt.fromAffine({ x: big(pub.cx), y: big(pub.cy) }).negate().toAffine();
assert.strictEqual(pool.scan(bob, [{ ...pub, cy: '0x' + negC.y.toString(16).padStart(64, '0') }]).length, 0);
assert.strictEqual(pool.scan(bob, [{ ...pub, cx: tweak(pub.cx, 31) }]).length, 0);
ok('tampered commitment (re-committed, negated, off-curve) is not received');

assert.strictEqual(pool.scan(bob, [{ ...pub, spendKey: pool.createNote(bob.address, ASSET, 1n).spendKey }]).length, 0);
assert.strictEqual(pool.scan(bob, [{ ...pub, nkPub: pool.createNote(bob.address, ASSET, 1n).nkPub }]).length, 0);
assert.strictEqual(pool.scan(bob, [{ ...pub, leaf: '0x' + '11'.repeat(32) }]).length, 0);
ok('substituted spend_key / nk_pub / leaf is not received');

// Payer seals 1 BTC in ct_note while C commits 1 sat.
{
  const e = 7777n + BigInt(Date.now());
  const honest = pool.createNote(bob.address, ASSET, 100_000_000n, 42n, { e });
  const small = pool.commitXY(1n, 42n);
  const lie = { asset: ASSET, cx: small.cx, cy: small.cy, spendKey: honest.spendKey, nkPub: honest.nkPub, pkEph: honest.pkEph, ctNote: honest.ctNote };
  assert.strictEqual(pool.scan(bob, [lie]).length, 0);
  assert.strictEqual(pool.scan(bob, [{ ...lie, cx: honest.cx, cy: honest.cy }]).length, 1);
}
ok('amount sealed in ct_note that does not open C (1 BTC sealed, 1 sat committed) is not received');

// ── sender cannot compute nf ──
{
  const e = BigInt('0x' + hex(rnd(31))) + 1n;
  const nt = pool.createNote(bob.address, ASSET, 5n, undefined, { e });
  const bobNote = pool.scan(bob, [{ ...nt, leafIndex: 3 }])[0];
  const V = Pt.fromHex(bob.V.slice(2));
  const s = V.multiply(e).toRawBytes(true);
  const tn = big(hex(keccak_256(new Uint8Array([...te.encode('tacit-btc-pool-nk-tweak-v1'), ...s])))) % N;
  const nfOf = (x32) => '0x' + hex(keccak_256(new Uint8Array([...te.encode('tacit-btc-pool-nf-v1'), ...unhex(nt.leaf), ...x32, 0, 0, 0, 0, 0, 0, 0, 3])));
  const b32 = (x) => unhex(x.toString(16).padStart(64, '0'));
  const senderGuesses = [nfOf(b32(tn)), nfOf(unhex(nt.nkPub).slice(1)), nfOf(unhex(nt.spendKey)), nfOf(b32(e)), nfOf(s.slice(1))];
  for (const g of senderGuesses) assert.notStrictEqual(g, bobNote.nf);
  assert.ok(G.multiply(tn).add(Pt.fromHex(bob.N.slice(2))).equals(Pt.fromHex(nt.nkPub.slice(2))));
  assert.ok(big(bobNote.nkNote) !== tn);
}
ok('sender knows e, s, t_n and NK but none of its derivations give the note\'s nf (needs n)');

// ── view-only wallet ──
{
  const view = pool.viewWallet(bob);
  assert.strictEqual(view.a, undefined); assert.strictEqual(view.n, undefined);
  const seen = pool.scan(view, [{ ...pub, leafIndex: 9 }]);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].value, VALUE);
  assert.strictEqual(seen[0].nf, undefined); assert.strictEqual(seen[0].nkNote, undefined); assert.strictEqual(seen[0].skSpend, undefined);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: seen, exit: { exitVout: 1, destSpkHash: '0x' + '00'.repeat(32) } }));
  const watch = pool.scan({ ...view, n: bob.n }, [{ ...pub, leafIndex: 9 }])[0];
  assert.strictEqual(watch.nf, pool.scan(bob, [{ ...pub, leafIndex: 9 }])[0].nf);
  assert.strictEqual(watch.skSpend, undefined);
}
ok('view-only wallet (v) detects and reads the note but has no nk_note, nf or sk_spend; (v, n) sees nf but cannot spend');

// ── pk_eph parity ──
{
  let odd = 0, even = 0;
  const notes = [];
  for (let i = 0; i < 200; i++) notes.push(pool.createNote(bob.address, ASSET, BigInt(i + 1)));
  for (const x of notes) (unhex(x.pkEph)[0] === 0x03 ? odd++ : even++);
  const rec = pool.scan(bob, notes);
  const recovered = rec.length;
  assert.ok(odd > 50 && even > 50, `parity split ${odd}/${even}`);
  assert.strictEqual(recovered, 200);
  assert.ok(rec.every((r, i) => r.value === BigInt(i + 1)));
  console.log(`    (pk_eph parity: ${even} even / ${odd} odd; recovered ${recovered}/200)`);
}
ok('pk_eph parity is random across 200 notes and every note is recovered');

// ── shield kernel ──
function bip340VerifyIndependent(sig, msg, px) {
  const th = (tag, ...m) => { const t = sha256(te.encode(tag)); return sha256(new Uint8Array([...t, ...t, ...m.flatMap((x) => [...x])])); };
  const r = big(hex(sig.slice(0, 32))), s = big(hex(sig.slice(32)));
  if (r >= secp.CURVE.p || s >= N) return false;
  const P = Pt.fromHex('02' + hex(px));
  const e = big(hex(th('BIP0340/challenge', sig.slice(0, 32), px, msg))) % N;
  const R = G.multiply(s).add(P.multiply(e).negate());
  const Rb = R.toRawBytes(true);
  return Rb[0] === 2 && hex(Rb.slice(1)) === hex(sig.slice(0, 32));
}
{
  const eParity = new Set();
  for (let trial = 0; trial < 16; trial++) {
    const nIn = 1 + (trial % 3);
    const inputs = [];
    for (let i = 0; i < nIn; i++) {
      const v = BigInt(1000 + trial * 10 + i), r = big(hex(rnd(32))) % N;
      const C = TACIT_H.multiply(v).add(G.multiply(r)).toAffine();
      inputs.push({ txid: hex(rnd(32)), vout: i + 1, Cx: '0x' + C.x.toString(16).padStart(64, '0'), Cy: '0x' + C.y.toString(16).padStart(64, '0'), value: v, blinding: r });
    }
    const sh = pool.buildShieldEnvelope({ asset: ASSET, inputs, recipientAddress: alice.addressString });
    assert.strictEqual(sh.payload.length, SHIELD_ENVELOPE_LEN);
    assert.strictEqual(sh.payload[0], T_BTC_SHIELD);
    assert.strictEqual(sh.payload[33], nIn);
    let E = Pt.fromAffine({ x: big(sh.note.cx), y: big(sh.note.cy) });
    for (const i of inputs) E = E.add(Pt.fromAffine({ x: big(i.Cx), y: big(i.Cy) }).negate());
    assert.ok(!E.equals(Pt.ZERO));
    eParity.add(E.toRawBytes(true)[0]);
    const parts = [te.encode('tacit-btc-pool-shield-v1'), unhex(ASSET), [nIn]];
    for (const i of inputs) { parts.push(unhex(i.txid).reverse()); parts.push([i.vout, 0, 0, 0]); }
    const p = sh.payload;
    parts.push(p.slice(34, 34 + 218));
    const msg = sha256(new Uint8Array(parts.flatMap((x) => [...x])));
    assert.ok(bip340VerifyIndependent(p.slice(252, 316), msg, E.toRawBytes(true).slice(1)));
    assert.ok(pool.verifyShield(p, inputs));
    const got = pool.scan(alice, [pool.parseShieldEnvelope(p).note]);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].value, inputs.reduce((s, i) => s + i.value, 0n));
    const bad = Uint8Array.from(p); bad[40] ^= 1;
    assert.ok(!pool.verifyShield(bad, inputs));
    assert.ok(!pool.verifyShield(p, inputs.map((i, j) => (j === 0 ? { ...i, vout: i.vout + 1 } : i))));
  }
  assert.strictEqual(eParity.size, 2);
  const v = 500n, r = 99n, C = pool.commitXY(v, r);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs: [{ txid: hex(rnd(32)), vout: 1, Cx: C.cx, Cy: C.cy, value: 501n, blinding: r }], recipientAddress: alice.address }));
}
ok('shield: 316 bytes, kernel verifies by an independent BIP-340 check under x(C_pool − ΣC_in), odd-y E included; tamper fails; recipient scans the exact total');

// ── spend body ──
function fakeTree(leaves) {
  const zeros = [new Uint8Array(32)];
  for (let d = 1; d <= 32; d++) zeros.push(keccak_256(new Uint8Array([...zeros[d - 1], ...zeros[d - 1]])));
  let level = leaves.map(unhex);
  const layers = [level];
  for (let d = 0; d < 32; d++) {
    const next = [];
    for (let i = 0; i < Math.max(1, Math.ceil(level.length / 2)); i++) {
      const l = level[2 * i] || zeros[d], rr = level[2 * i + 1] || zeros[d];
      next.push(keccak_256(new Uint8Array([...l, ...rr])));
    }
    layers.push(next); level = next;
  }
  const path = (idx) => { const out = []; for (let d = 0; d < 32; d++) { const sib = idx ^ 1; out.push('0x' + hex(layers[d][sib] || zeros[d])); idx >>= 1; } return out; };
  return { root: '0x' + hex(layers[32][0]), path };
}
{
  const n1 = pool.createNote(bob.address, ASSET, 700n);
  const n2 = pool.createNote(bob.address, ASSET, 300n);
  const filler = pool.createNote(eve.address, ASSET, 1n);
  const tree = fakeTree([filler.leaf, n1.leaf, n2.leaf]);
  const mine = pool.scan(bob, [filler, n1, n2].map((x, i) => ({ ...x, leafIndex: i }))).map((x) => ({ ...x, path: tree.path(x.leafIndex) }));
  assert.strictEqual(mine.length, 2);

  const pay = pool.buildSpendBody({ asset: ASSET, hAnchor: 250_000, root: tree.root, inputs: mine, outputs: [{ address: alice.addressString, value: 600n }, { address: bob.addressString, value: 400n }] });
  const parsed = pool.parseSpend(pay.body);
  assert.strictEqual(parsed.exit, null);
  assert.strictEqual(parsed.hAnchor, 250_000);
  assert.deepStrictEqual(parsed.nullifiers, pay.nullifiers);
  assert.deepStrictEqual(parsed.nullifiers, mine.map((m) => m.nf));
  {
    const twin = { ...mine[0], leafIndex: 40 };
    assert.notStrictEqual(pool.nullifier(twin.leaf, twin.nkNote, twin.leafIndex), mine[0].nf);
  }
  const re = pool.encodeSpendBody({ asset: ASSET, hAnchor: parsed.hAnchor, nullifiers: parsed.nullifiers, outputs: parsed.outputs, exit: parsed.exit });
  assert.strictEqual(hex(re), hex(pay.body));
  assert.strictEqual(pay.body.length, 1 + 32 + 4 + 1 + 64 + 1 + 2 * 218 + 1);
  assert.strictEqual(pay.body[pay.body.length - 1], 0);
  assert.deepStrictEqual([...pay.body.slice(33, 37)], [0x90, 0xd0, 0x03, 0x00]);
  const msg = keccak_256(new Uint8Array([...te.encode('tacit-btc-pool-spend-v1'), ...pay.body]));
  mine.forEach((m, i) => assert.ok(bip340VerifyIndependent(unhex(pay.sigs[i]), msg, unhex(m.spendKey))));
  assert.strictEqual(pool.scan(alice, parsed.outputs)[0].value, 600n);
  assert.strictEqual(pool.scan(bob, parsed.outputs)[0].value, 400n);

  const w = pay.witness;
  assert.deepStrictEqual(Object.keys(w), ['body', 'root', 'inputs', 'outputs']);
  assert.deepStrictEqual(Object.keys(w.inputs[0]), ['cx', 'cy', 'value', 'blinding', 'spend_key', 'nk_pub', 'nk_note', 'leaf_index', 'path', 'sig']);
  assert.strictEqual(w.inputs[0].value, '700'); assert.strictEqual(typeof w.inputs[0].leaf_index, 'number');
  assert.strictEqual(w.inputs[0].path.length, 32);
  assert.deepStrictEqual(w.outputs.map((o) => o.value), ['600', '400']);
  assert.strictEqual(w.outputs[0].blinding, pay.outputs[0].blinding);
  JSON.parse(JSON.stringify(w));

  for (const [label, mutate] of [
    ['trailing byte', (b) => new Uint8Array([...b, 0])],
    ['n_in 3', (b) => { const c = Uint8Array.from(b); c[37] = 3; return c; }],
    ['has_exit 2', (b) => { const c = Uint8Array.from(b); c[c.length - 1] = 2; return c; }],
    ['n_out 4', (b) => { const c = Uint8Array.from(b); c[38 + 64] = 4; return c; }],
    ['no output, no exit', (b) => new Uint8Array([...b.slice(0, 38 + 64), 0, 0])],
    ['truncated', (b) => b.slice(0, b.length - 1)],
  ]) assert.throws(() => pool.parseSpend(mutate(pay.body)), undefined, label);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: mine, outputs: [{ address: alice.address, value: 999n }] }));
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, root: '0x' + '00'.repeat(32), inputs: mine, outputs: [{ address: alice.address, value: 1000n }] }));

  const spk = new Uint8Array([0x00, 0x14, ...rnd(20)]);
  const ex = pool.buildSpendBody({ asset: ASSET, hAnchor: 7, root: tree.root, inputs: [mine[0]], exit: { exitVout: 2, scriptPubKey: spk } });
  const pe = pool.parseSpend(ex.body);
  assert.strictEqual(pe.outputs.length, 0);
  assert.strictEqual(pe.exit.exitVout, 2);
  assert.strictEqual(pe.exit.destSpkHash, '0x' + hex(sha256(spk)));
  assert.ok(Pt.fromAffine({ x: big(pe.exit.cx), y: big(pe.exit.cy) }).equals(TACIT_H.multiply(700n).add(G.multiply(big(ex.exit.blinding)))));
  assert.strictEqual(ex.body.length, 1 + 32 + 4 + 1 + 32 + 1 + 1 + 100);
  assert.deepStrictEqual(ex.witness.outputs, [{ value: '700', blinding: ex.exit.blinding }]);

  const part = pool.buildSpendBody({ asset: ASSET, hAnchor: 8, root: tree.root, inputs: mine, outputs: [{ address: alice.address, value: 100n }, { address: bob.address, value: 200n }, { address: eve.address, value: 300n }], exit: { exitVout: 0, scriptPubKey: spk } });
  const pp = pool.parseSpend(part.body);
  assert.strictEqual(pp.outputs.length, 3);
  assert.strictEqual(part.exit.value, 400n);
  assert.deepStrictEqual(part.witness.outputs.map((o) => o.value), ['100', '200', '300', '400']);
  assert.strictEqual(part.witness.outputs[3].blinding, part.exit.blinding);
  assert.strictEqual('0x' + hex(pool.encodeSpendBody({ asset: ASSET, hAnchor: 8, nullifiers: pp.nullifiers, outputs: pp.outputs, exit: pp.exit })), part.bodyHex);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 8, inputs: mine, outputs: [1, 2, 3, 4].map(() => ({ address: alice.address, value: 250n })) }));
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 8, inputs: mine, outputs: [{ address: alice.address, value: 100n }], exit: { exitVout: 0, scriptPubKey: spk, value: 1n } }));

  const proof = rnd(260);
  const full = pool.assembleSpendEnvelope(ex.body, proof);
  assert.deepStrictEqual([...full.slice(ex.body.length, ex.body.length + 2)], [260 & 0xff, 260 >> 8]);
  const pf = pool.parseSpend(full, { full: true });
  assert.strictEqual(pf.proof, '0x' + hex(proof));
  assert.strictEqual(hex(pf.body), hex(ex.body));
  assert.throws(() => pool.assembleSpendEnvelope(ex.body, rnd(513)));
}
ok('spend body: canonical LE layout, parse/encode round-trip, per-input BIP-340 over keccak(domain ‖ body), witness JSON shape; exit binds SHA-256(spk); partial exit with 3 outputs; proof_len LE');

// ── cross-check against the Rust-generated vectors, when present ──
const VEC = new URL('./vectors/btc-pool-vectors.json', import.meta.url);
if (existsSync(VEC)) {
  const vec = JSON.parse(readFileSync(VEC, 'utf8'));
  const lc = (h) => '0x' + String(h).toLowerCase().replace(/^0x/, '');
  const indexedNf = /leaf_index/.test(vec.formulas?.nullifier || '');
  const nfNoIndex = (leaf, nk) => '0x' + hex(keccak_256(new Uint8Array([...te.encode('tacit-btc-pool-nf-v1'), ...unhex(leaf), ...unhex(nk)])));
  let checked = 0;
  const checkNote = (c) => {
    if (c.value != null && c.blinding) { const C = pool.commitXY(BigInt(c.value), big(c.blinding)); assert.strictEqual(C.cx, lc(c.cx)); assert.strictEqual(C.cy, lc(c.cy)); checked++; }
    assert.strictEqual(pool.noteLeaf(c.asset, c.cx, c.cy, c.spend_key, c.nk_pub), lc(c.leaf)); checked++;
    if (c.nk_note) assert.strictEqual('0x' + hex(G.multiply(big(c.nk_note)).toRawBytes(true)), lc(c.nk_pub));
  };
  for (const c of vec.leaf_and_nullifier || []) {
    checkNote(c);
    if (c.leaf_index != null) { assert.strictEqual(pool.nullifier(c.leaf, c.nk_note, c.leaf_index), lc(c.nullifier)); checked++; }
    else if (!indexedNf) { assert.strictEqual(nfNoIndex(c.leaf, c.nk_note), lc(c.nullifier)); checked++; }
  }
  for (const c of vec.spend_msg || []) { assert.strictEqual(pool.spendMsg(c.body), lc(c.spend_msg)); checked++; }
  for (const sp of vec.spends || []) {
    const f = sp.fields;
    const parsed = pool.parseSpend(f.body);
    assert.strictEqual(parsed.hAnchor, Number(f.h_anchor));
    assert.deepStrictEqual(parsed.nullifiers, f.nullifiers.map(lc));
    assert.strictEqual(parsed.outputs.length, f.outputs.length);
    assert.strictEqual(!!parsed.exit, !!Number(f.has_exit));
    const re = pool.encodeSpendBody({ asset: f.asset, hAnchor: parsed.hAnchor, nullifiers: parsed.nullifiers, outputs: parsed.outputs, exit: parsed.exit });
    assert.strictEqual('0x' + hex(re), lc(f.body));
    f.outputs.forEach((o, j) => { assert.strictEqual(parsed.outputs[j].leaf, lc(o.leaf)); assert.strictEqual(parsed.outputs[j].pkEph, lc(o.pk_eph)); });
    if (f.exit) { assert.strictEqual(parsed.exit.exitVout, Number(f.exit.exit_vout)); assert.strictEqual(parsed.exit.destSpkHash, lc(f.exit.dest_spk_hash)); assert.strictEqual(parsed.exit.cx, lc(f.exit.cx)); }
    assert.strictEqual('0x' + hex(keccak_256(unhex(f.body))), lc(f.body_hash));
    assert.strictEqual(pool.spendMsg(f.body), lc(f.spend_msg));
    const w = sp.witness;
    w.inputs.forEach((wi, i) => {
      const ns = sp.notes_spent[i];
      const leaf = pool.noteLeaf(f.asset, wi.cx, wi.cy, wi.spend_key, wi.nk_pub);
      assert.strictEqual(leaf, lc(ns.leaf));
      assert.strictEqual(pool.merkleRootFrom(leaf, wi.leaf_index, wi.path), lc(w.root));
      assert.ok(pool.schnorrVerify(wi.sig, f.spend_msg, wi.spend_key));
      assert.strictEqual(hex(G.multiply(big(ns.spend_sk)).toRawBytes(true).slice(1)), wi.spend_key.toLowerCase().replace(/^0x/, ''));
      const nf = indexedNf ? pool.nullifier(leaf, wi.nk_note, wi.leaf_index) : nfNoIndex(leaf, wi.nk_note);
      assert.strictEqual(nf, lc(ns.nullifier));
      assert.strictEqual(nf, parsed.nullifiers[i]);
      checked += 5;
    });
    assert.deepStrictEqual(Object.keys(w).sort(), ['body', 'inputs', 'outputs', 'root']);
    assert.deepStrictEqual(Object.keys(w.inputs[0]).sort(), ['blinding', 'cx', 'cy', 'leaf_index', 'nk_note', 'nk_pub', 'path', 'sig', 'spend_key', 'value']);
  }
  ok(`Rust vectors cross-checked (${checked} checks)`);
  if (!indexedNf) console.log('    NOTE: vectors use nf without leaf_index; wallet nf includes it (spec update). Re-generate vectors.');
} else {
  console.log('  skip - tests/vectors/btc-pool-vectors.json not present');
}

console.log(`\n${n} passed`);
