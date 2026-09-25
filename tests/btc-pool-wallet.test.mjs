// Wallet side of the Bitcoin-native shielded pool (DESIGN-btc-shielded-pool.md §2–§6), client-proved relation.
// Keys and addresses, notes and view tiers, shield and spend bodies with their circuit witnesses, wallet
// defaults, exit keys and exit recovery. One real pay proof; everything else checks witness publics against
// the indexer's derivation without proving.
// Run: node tests/btc-pool-wallet.test.mjs     (REGEN=1 rewrites tests/vectors/btc-pool-wallet-vectors.json)
import assert from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';
import { makeBtcShieldedPool, defaultAnchor, T_BTC_SHIELD, T_BTC_SPEND, ADDRESS_LEN, CT_NOTE_LEN, POOL_NOTE_LEN, BOUNDARY_LEN, BTC_POOL_MAX_PROOF } from '../dapp/btc-shielded-pool.js';
import { assetField, bodyHash, spendPublics, hsL, hsP, mulB8, pedersenBJJ, publicSignals, L_BJJ, P_FR } from '../dapp/btc-pool-zk.js';
import { verifyBoundary, decodeBoundary } from '../dapp/btc-pool-zk-boundary.js';
import { makeGroth16System } from '../dapp/btc-pool-zk-prover.js';
import { addPoint, unpackPoint, packPoint, eq as bjjEq } from '../dapp/amm-bjj.js';
import * as W from '../worker/src/btc-shielded-pool.js';
import { H as TACIT_H } from './bulletproofs.mjs';

const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256, ripemd160 });
const Pt = secp.ProjectivePoint, G = Pt.BASE, N = secp.CURVE.n;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const big = (h) => BigInt('0x' + String(h).replace(/^0x/, ''));
const b32 = (x) => unhex(BigInt(x).toString(16).padStart(64, '0'));
const f32 = (x) => '0x' + BigInt(x).toString(16).padStart(64, '0');
const cat = (...xs) => { const o = new Uint8Array(xs.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const te = new TextEncoder();
const Hs = (...parts) => big(hex(keccak_256(cat(...parts)))) % N;
const compress = (P) => P.toRawBytes(true);
const flip = (h, i) => { const b = unhex(h); b[i] ^= 1; return '0x' + hex(b); };

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const T0 = performance.now();

const ASSET = '0x' + 'ab'.repeat(32);
const alice = pool.walletFromSeed(rnd(32), 'signet');
const bob = pool.walletFromSeed(rnd(32), 'signet');
const eve = pool.walletFromSeed(rnd(32), 'signet');

// Poseidon tree as the indexer keeps it; paths as the relayer serves them.
function treeOf(leaves) {
  const t = new W.PoseidonTree();
  for (const l of leaves) t.append(unhex(l));
  return { root: '0x' + hex(t.root()), path: (i) => t.rootAndPath(i).path.map((p) => '0x' + hex(p)) };
}
function bip340VerifyIndependent(sig, msg, px) {
  const th = (tag, ...m) => { const t = sha256(te.encode(tag)); return sha256(cat(t, t, ...m)); };
  const r = big(hex(sig.slice(0, 32))), s = big(hex(sig.slice(32)));
  if (r >= secp.CURVE.p || s >= N) return false;
  const P = Pt.fromHex('02' + hex(px));
  const e = big(hex(th('BIP0340/challenge', sig.slice(0, 32), px, msg))) % N;
  const R = G.multiply(s).add(P.multiply(e).negate());
  const Rb = R.toRawBytes(true);
  return Rb[0] === 2 && hex(Rb.slice(1)) === hex(sig.slice(0, 32));
}
// Publics the indexer (worker) derives for an assembled envelope.
function workerPublics(payload, root) {
  const s = W.parseEnvelope(payload);
  assert.ok(s, 'worker parses the envelope');
  const bd = s.kind === 'shield' ? s.boundary : s.exit?.boundary;
  const C = bd ? verifyBoundary(bd) : null;
  if (bd) assert.ok(C, 'worker boundary verifies');
  return W.envelopePublics(s, { root: root != null ? unhex(root) : null, boundaryC: C });
}
const FAKE_PROOF = new Uint8Array(256).fill(7);

// ── generator, keys, addresses ──
assert.ok(pool.H.equals(TACIT_H));
ok('Pedersen H is the Tacit NUMS generator');

const seed = rnd(32);
const w1 = pool.walletFromSeed(seed), w2 = pool.walletFromSeed(seed);
{
  assert.deepStrictEqual(w1, w2);
  assert.strictEqual(w1.network, 'signet');
  const net = te.encode('signet');
  assert.strictEqual(big(w1.v), Hs(te.encode('tacit-btc-pool-wallet-view-v1'), net, seed));
  assert.strictEqual(big(w1.vInt), Hs(te.encode('tacit-btc-pool-wallet-view-internal-v1'), net, seed));
  assert.strictEqual(w1.exitRoot, '0x' + hex(keccak_256(cat(te.encode('tacit-btc-pool-wallet-exit-v1'), net, seed))));
  assert.strictEqual(big(w1.a), hsL('tacit-btc-pool-zk-wallet-spend-v1', 'signet', seed));
  assert.strictEqual(big(w1.n), hsL('tacit-btc-pool-zk-wallet-nk-v1', 'signet', seed));
  assert.strictEqual(w1.V, '0x' + hex(compress(G.multiply(big(w1.v)))));
  assert.strictEqual(w1.A, '0x' + hex(packPoint(mulB8(big(w1.a)))));
  assert.strictEqual(w1.N, '0x' + hex(packPoint(mulB8(big(w1.n)))));
  assert.strictEqual(w1.address, w1.V + w1.A.slice(2) + w1.N.slice(2));
  assert.strictEqual(unhex(w1.address).length, ADDRESS_LEN);
  assert.strictEqual(new Set([w1.v, w1.a, w1.n, w1.vInt]).size, 4);
  assert.ok(w1.addressString.startsWith('tbp1'));
  assert.strictEqual(w1.addressString.length, 4 + Math.ceil(97 * 8 / 5) + 6);
  const dec = pool.decodeAddress(w1.addressString);
  assert.strictEqual('0x' + hex(dec.bytes), w1.address);
  assert.strictEqual(dec.network, 'signet');
  assert.strictEqual(pool.decodeAddress(w1.addressString.toUpperCase()).network, 'signet');
  assert.throws(() => pool.decodeAddress(w1.addressString.slice(0, 10) + w1.addressString.slice(10).toUpperCase()), /mixed-case/);
  const last = w1.addressString.slice(-1);
  assert.throws(() => pool.decodeAddress(w1.addressString.slice(0, -1) + (last === 'q' ? 'p' : 'q')), /checksum/);
  assert.throws(() => pool.decodeAddress('xyz' + w1.addressString.slice(3)));
  // A bech32m string with the right checksum over a 96-byte payload.
  assert.throws(() => pool.decodeAddress(pool.encodeAddress(w1.address, 'signet').slice(0, 4) + 'q'), /malformed|checksum/);
  // A point that is not a BabyJub subgroup point in the A slot.
  const badA = cat(unhex(w1.V), new Uint8Array(32).fill(0xff), unhex(w1.N));
  assert.throws(() => pool.decodeAddress(badA, 'signet'));
  // internal address: same A ‖ N, different V.
  assert.strictEqual(w1.internalAddress.slice(2 + 66), w1.address.slice(2 + 66));
  assert.notStrictEqual(w1.internalAddress.slice(0, 68), w1.address.slice(0, 68));
  assert.strictEqual(w1.VInt, '0x' + hex(compress(G.multiply(big(w1.vInt)))));
}
ok('seed → (v, v_int, a, n, exit_root) deterministic and domain-separated; 97-byte V ‖ A ‖ N address; bech32m round-trip, checksum and case enforced; internal address shares A ‖ N');

// ── network binding ──
{
  const m = pool.walletFromSeed(seed, 'mainnet');
  for (const key of ['v', 'a', 'n', 'vInt', 'exitRoot', 'V', 'A', 'N', 'address']) assert.notStrictEqual(m[key], w1[key], key);
  assert.ok(m.addressString.startsWith('bp1'));
  assert.strictEqual(pool.decodeAddress(m.addressString).network, 'mainnet');
  assert.throws(() => pool.walletFromSeed(seed, 'regtest'), /unknown network/);
  assert.throws(() => pool.decodeAddress(w1.addressString, 'mainnet'), /expected mainnet/);
  assert.throws(() => pool.decodeAddress(m.addressString, 'signet'), /expected signet/);
  assert.throws(() => pool.decodeAddress(w1.address), /explicit network/);
  assert.throws(() => pool.decodeAddress(unhex(w1.address)), /explicit network/);
  assert.strictEqual(pool.decodeAddress(w1.address, 'signet').network, 'signet');
  assert.throws(() => pool.decodeAddress(w1.address, 'testnet'), /unknown network/);
  assert.throws(() => pool.createNote(w1.address, ASSET, 1n), /explicit network/);
  assert.ok(pool.createNote(w1.address, ASSET, 1n, { network: 'signet' }).leaf);
  assert.throws(() => pool.createNote(w1.addressString, ASSET, 1n, { network: 'mainnet' }), /expected mainnet/);
  assert.throws(() => pool.encodeAddress(w1.address, 'testnet'), /unknown network/);
  assert.strictEqual(pool.encodeAddress(m.address, 'mainnet'), m.addressString);
  const v = 5n, r = 77n, C = pool.commitXY(v, r);
  const inputs = [{ txid: hex(rnd(32)), vout: 0, Cx: C.cx, Cy: C.cy, value: v, blinding: r }];
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs, recipientAddress: w1.address }), /explicit network/);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs, recipientAddress: w1.addressString, network: 'mainnet' }), /expected mainnet/);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs: [inputs[0], inputs[0]], recipientAddress: w1.addressString }), /repeated/);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs: [{ ...inputs[0], vout: 1.5 }], recipientAddress: w1.addressString }), /vout/);
}
assert.notStrictEqual(pool.deriveExitKey(pool.walletFromSeed(seed, 'mainnet'), 0).scriptPubKey, pool.deriveExitKey(w1, 0).scriptPubKey);
ok('keys, addresses and exit keys are per network; an address for the wrong network is refused; raw addresses need an explicit network');

// ── notes: Alice → Bob ──
const VALUE = 123_456_789n;
const E1 = Hs(te.encode('test-eph'), rnd(32));
const note = pool.createNote(bob.addressString, ASSET, VALUE, { e: E1 });
const pub = { asset: note.asset, leaf: note.leaf, pkEph: note.pkEph, ctNote: note.ctNote };
{
  assert.deepStrictEqual(Object.keys(note).sort(), ['asset', 'ctNote', 'leaf', 'npk', 'pkEph', 'rho', 'value']);
  assert.strictEqual(unhex(note.pkEph).length, 33);
  assert.strictEqual(unhex(note.ctNote).length, CT_NOTE_LEN);
  assert.strictEqual(note.pkEph, '0x' + hex(compress(G.multiply(E1))));
  // Independent note model: s = e·V, tweaks from s, npk = P(Ak, NK), leaf = P(assetF, v, npk, rho).
  const s = compress(Pt.fromHex(bob.V.slice(2)).multiply(E1));
  const tA = hsL('tacit-btc-pool-zk-auth-tweak-v1', s), tN = hsL('tacit-btc-pool-zk-nk-tweak-v1', s), rho = hsP('tacit-btc-pool-zk-rho-v1', s);
  const Ak = addPoint(unpackPoint(unhex(bob.A)), mulB8(tA));
  const NK = addPoint(unpackPoint(unhex(bob.N)), mulB8(tN));
  const npk = poseidon4([Ak[0], Ak[1], NK[0], NK[1]]);
  assert.strictEqual(note.npk, f32(npk));
  assert.strictEqual(note.rho, f32(rho));
  assert.strictEqual(note.leaf, f32(poseidon4([assetField(unhex(ASSET)), VALUE, npk, rho])));
  // ct_note = v(8, BE) ⊕ keystream ‖ tag(16).
  const key = keccak_256(cat(te.encode('tacit-btc-pool-zk-aead-v1'), s));
  const ks = keccak_256(cat(key, Uint8Array.of(0, 0))).slice(0, 8);
  const ct = b32(VALUE).slice(24).map((x, i) => x ^ ks[i]);
  const tag = keccak_256(cat(te.encode('tacit-btc-pool-zk-aead-tag-v1'), key, ct)).slice(0, 16);
  assert.strictEqual(note.ctNote, '0x' + hex(cat(ct, tag)));

  const got = pool.scan(bob, [{ ...pub, leafIndex: 5 }]);
  assert.strictEqual(got.length, 1);
  const g = got[0];
  assert.strictEqual(g.value, VALUE);
  assert.strictEqual(g.leaf, note.leaf);
  assert.strictEqual(g.leafIndex, 5);
  assert.strictEqual(g.internal, undefined);
  assert.strictEqual(big(g.skNote), (big(bob.a) + tA) % L_BJJ);
  assert.strictEqual(big(g.nkNote), (big(bob.n) + tN) % L_BJJ);
  assert.ok(bjjEq(mulB8(big(g.skNote)), Ak));
  assert.deepStrictEqual(g.ak, Ak.map(f32));
  assert.ok(bjjEq(mulB8(big(g.nkNote)), NK));
  assert.strictEqual(g.nf, f32(poseidon3([big(g.nkNote), big(note.leaf), 5n])));
  assert.strictEqual(pool.nullifier(g.nkNote, g.leaf, 5), g.nf);
  assert.throws(() => pool.nullifier(g.nkNote, g.leaf), /leaf_index/);
  const again = pool.scan(bob, [{ ...pub, leafIndex: 6 }, pub]);
  assert.notStrictEqual(again[0].nf, g.nf);
  assert.strictEqual(again[1].nf, undefined);
  assert.strictEqual(again[1].nkNote, g.nkNote);
  // The sender knows e, s, t_n and NK; none of them yields the nullifier without n.
  const guesses = [tN, big(hex(s.slice(1))) % P_FR, E1 % L_BJJ, NK[0], npk].map((x) => f32(poseidon3([x, big(note.leaf), 5n])));
  for (const x of guesses) assert.notStrictEqual(x, g.nf);
}
ok('createNote matches the independent note model (s = e·V, npk, rho, Poseidon leaf, sealed v ‖ tag); Bob\'s scan yields value, sk_note opening Ak, nk_note opening NK, nf = P(nk, leaf, index); the sender cannot derive nf');

// ── non-receipt ──
{
  assert.strictEqual(pool.scan(eve, [pub]).length, 0);
  assert.strictEqual(pool.scan(alice, [pub]).length, 0);
  for (let i = 0; i < CT_NOTE_LEN; i += 3) assert.strictEqual(pool.scan(bob, [{ ...pub, ctNote: flip(pub.ctNote, i) }]).length, 0);
  assert.strictEqual(pool.scan(bob, [{ ...pub, ctNote: pub.ctNote.slice(0, -2) }]).length, 0);
  assert.strictEqual(pool.scan(bob, [{ ...pub, leaf: flip(pub.leaf, 31) }]).length, 0);
  assert.strictEqual(pool.scan(bob, [{ ...pub, asset: '0x' + 'cd'.repeat(32) }]).length, 0);
  assert.strictEqual(pool.scan(bob, [{ ...pub, pkEph: '0x' + hex(compress(G.multiply(E1 + 1n))) }]).length, 0);
  assert.strictEqual(pool.scan(bob, [{ ...pub, pkEph: '0x04' + pub.pkEph.slice(4) }]).length, 0);
  // Sealed to Bob, leaf paying Eve's keys: Bob's view opens but the leaf is not his.
  const e = Hs(te.encode('mix'), rnd(32));
  const toBob = pool.createNote(bob.addressString, ASSET, 1_000n, { e });
  const toEve = pool.createNote(eve.addressString, ASSET, 1_000n, { e });
  assert.strictEqual(toBob.pkEph, toEve.pkEph);
  const mixed = { asset: ASSET, leaf: toEve.leaf, pkEph: toBob.pkEph, ctNote: toBob.ctNote };
  assert.strictEqual(pool.scan(bob, [mixed]).length, 0);
  assert.strictEqual(pool.scan(eve, [mixed]).length, 0);
  // 1 BTC sealed in ct_note, 1 sat in the leaf.
  const honest = pool.createNote(bob.addressString, ASSET, 100_000_000n, { e });
  const small = pool.createNote(bob.addressString, ASSET, 1n, { e });
  assert.strictEqual(pool.scan(bob, [{ asset: ASSET, leaf: small.leaf, pkEph: honest.pkEph, ctNote: honest.ctNote }]).length, 0);
  assert.strictEqual(pool.scan(bob, [{ asset: ASSET, leaf: honest.leaf, pkEph: honest.pkEph, ctNote: honest.ctNote }])[0].value, 100_000_000n);
}
ok('not received: another wallet, the sender, tampered ct_note / leaf / asset / pk_eph, a leaf paying another address\'s keys under a ct sealed to the viewer, a sealed value the leaf does not commit');

// ── view tiers ──
{
  const view = pool.viewWallet(bob);
  assert.deepStrictEqual(Object.keys(view).sort(), ['A', 'N', 'V', 'address', 'addressString', 'network', 'v']);
  const seen = pool.scan(view, [{ ...pub, leafIndex: 9 }]);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].value, VALUE);
  for (const k of ['nf', 'nkNote', 'skNote', 'ak']) assert.strictEqual(seen[0][k], undefined, k);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: seen, outputs: [{ address: alice.addressString, value: VALUE }] }), /not a spendable/);
  assert.throws(() => pool.deriveExitKey(view, 0), /exit root/);
  const watch = pool.scan({ ...view, n: bob.n }, [{ ...pub, leafIndex: 9 }])[0];
  assert.strictEqual(watch.nf, pool.scan(bob, [{ ...pub, leafIndex: 9 }])[0].nf);
  assert.strictEqual(watch.skNote, undefined);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: [watch], outputs: [{ address: alice.addressString, value: VALUE }] }), /not a spendable/);
  const fv = pool.fullViewWallet(bob);
  assert.strictEqual(fv.a, undefined); assert.strictEqual(fv.exitRoot, undefined);
  assert.strictEqual(fv.n, bob.n); assert.strictEqual(fv.vInt, bob.vInt);
  assert.throws(() => pool.fullViewWallet(view), /v_int and n/);
  assert.throws(() => pool.viewWallet(view, { internal: true }), /no v_int/);
  const wv = pool.walletFromScalars({ v: big(bob.v), a: big(bob.a), n: big(bob.n) }, 'signet');
  assert.strictEqual(wv.address, bob.address);
  assert.strictEqual(wv.internalAddress, undefined);
  assert.throws(() => pool.walletFromScalars({ v: 1n, a: L_BJJ, n: 1n }), /zero BabyJub/);
}
ok('view tiers: v reads value only; (v, n) adds nf; neither can spend or derive exit keys; full view needs v_int and n');

// ── pk_eph parity ──
{
  let odd = 0;
  const notes = [];
  for (let i = 0; i < 40; i++) notes.push(pool.createNote(bob.addressString, ASSET, BigInt(i + 1)));
  for (const x of notes) if (unhex(x.pkEph)[0] === 0x03) odd++;
  const rec = pool.scan(bob, notes);
  assert.ok(odd >= 5 && odd <= 35, `parity split ${odd}/40`);
  assert.strictEqual(rec.length, 40);
  assert.ok(rec.every((r, i) => r.value === BigInt(i + 1)));
  console.log(`    (pk_eph parity: ${40 - odd} even / ${odd} odd; recovered ${rec.length}/40)`);
}
ok('pk_eph parity varies and every note is recovered');

// ── Schnorr under an odd-y key ──
{
  let d = 2n; while (compress(G.multiply(d))[0] !== 0x03) d++;
  const msg = sha256(rnd(8));
  const sig = pool.schnorrSign(msg, d);
  assert.ok(bip340VerifyIndependent(sig, msg, compress(G.multiply(d)).slice(1)));
  assert.ok(pool.schnorrVerify(sig, msg, compress(G.multiply(d)).slice(1)));
  assert.ok(W.bip340Verify(sig, msg, compress(G.multiply(d)).slice(1)));
  assert.ok(!pool.schnorrVerify(flip('0x' + hex(sig), 40), msg, compress(G.multiply(d)).slice(1)));
}
ok('BIP-340 signing negates an odd-y key; independent and indexer verifiers agree');

// ── shield ──
{
  // Two runs: kernel excess E forced even-y, then odd-y (rPool pinned).
  const mkInputs = (k) => Array.from({ length: k }, (_, i) => {
    const v = BigInt(1000 + i), r = big(hex(rnd(32))) % N;
    const C = TACIT_H.multiply(v).add(G.multiply(r)).toAffine();
    return { txid: hex(rnd(32)), vout: i + 1, Cx: f32(C.x), Cy: f32(C.y), value: v, blinding: r };
  });
  const pickR = (inputs, parity) => {
    const rIn = inputs.reduce((s, i) => (s + i.blinding) % N, 0n);
    for (let r = 5n; ; r++) if (compress(G.multiply((r - rIn + N) % N))[0] === parity) return r;
  };
  const runs = [];
  for (const [k, parity, outputs] of [[2, 0x02, null], [3, 0x03, 'split']]) {
    const inputs = mkInputs(k);
    const total = inputs.reduce((s, i) => s + i.value, 0n);
    const outs = outputs ? [{ address: alice.addressString, value: 1000n }, { address: bob.address, network: 'signet', value: total - 1000n }] : null;
    const rPool = pickR(inputs, parity);
    const sh = pool.buildShieldEnvelope({ asset: ASSET, inputs, recipientAddress: alice.address, network: 'signet', outputs: outs, rPool });
    const nOut = outs ? 2 : 1;
    const body = sh.body;
    assert.strictEqual(body.length, 35 + nOut * POOL_NOTE_LEN + BOUNDARY_LEN);
    assert.strictEqual(body[0], T_BTC_SHIELD);
    assert.strictEqual('0x' + hex(body.slice(1, 33)), ASSET);
    assert.strictEqual(body[33], k); assert.strictEqual(body[34], nOut);
    assert.strictEqual(sh.total, total);
    const payload = pool.assembleShield(sh, FAKE_PROOF);
    assert.strictEqual(payload.length, body.length + 64 + 2 + 256);
    assert.deepStrictEqual([...payload.slice(body.length + 64, body.length + 66)], [0, 1]);
    const ps = pool.parseShield(payload);
    assert.strictEqual(hex(ps.body), hex(body));
    assert.strictEqual(ps.nIn, k);
    // C_pool opens to (total, rPool); the kernel signs under x(C_pool − ΣC_in).
    const Cpool = Pt.fromHex(ps.cSecp.slice(2));
    assert.ok(Cpool.equals(TACIT_H.multiply(total).add(G.multiply(rPool))));
    let E = Cpool;
    for (const i of inputs) E = E.add(Pt.fromAffine({ x: big(i.Cx), y: big(i.Cy) }).negate());
    assert.strictEqual(compress(E)[0], parity);
    const parts = [te.encode('tacit-btc-pool-zk-shield-v1')];
    for (const i of inputs) parts.push(unhex(i.txid).reverse(), Uint8Array.of(i.vout, 0, 0, 0));
    parts.push(body);
    const msg = sha256(cat(...parts));
    assert.strictEqual(sh.kernelMsg, '0x' + hex(msg));
    assert.strictEqual(hex(W.shieldKernelMsg(body, inputs)), hex(msg));
    assert.ok(bip340VerifyIndependent(unhex(sh.kernelSig), msg, compress(E).slice(1)));
    assert.ok(W.bip340Verify(unhex(sh.kernelSig), msg, W.pointXY(E).cx));
    assert.ok(pool.verifyShieldKernel(payload, inputs));
    const bad = Uint8Array.from(payload); bad[40] ^= 1;
    assert.ok(!pool.verifyShieldKernel(bad, inputs));
    assert.ok(!pool.verifyShieldKernel(payload, inputs.map((i, j) => (j === 0 ? { ...i, vout: i.vout + 7 } : i))));
    assert.ok(!pool.verifyShieldKernel(payload, inputs.slice(1)));
    // Witness publics = what the wallet and the indexer derive from the envelope.
    const { publics } = pool.payloadPublics(payload);
    assert.deepStrictEqual(sh.witness.publicSignals, publics);
    assert.deepStrictEqual(workerPublics(payload), publics);
    assert.deepStrictEqual(publics.slice(0, 5), ['0', String(bodyHash(body)), String(assetField(unhex(ASSET))), '0', '0']);
    assert.deepStrictEqual(publicSignals(sh.witness.input), publics);
    assert.strictEqual(sh.witness.input.depV, String(total));
    runs.push({ sh, payload, total, outs });
    // Recipients scan their notes.
    if (!outs) assert.deepStrictEqual(pool.scan(alice, ps.outputs).map((x) => x.value), [total]);
    else {
      assert.deepStrictEqual(pool.scan(alice, ps.outputs).map((x) => x.value), [1000n]);
      assert.deepStrictEqual(pool.scan(bob, ps.outputs).map((x) => x.value), [total - 1000n]);
    }
    // Worker and wallet parsers agree.
    const ws = W.parseShield(payload);
    assert.strictEqual(hex(ws.body), hex(ps.body));
    assert.deepStrictEqual(ws.outputs.map((o) => '0x' + hex(o.leaf)), ps.outputs.map((o) => o.leaf));
  }
  // Refusals before any boundary work.
  const inputs = mkInputs(1);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs: [{ ...inputs[0], value: 1001n }], recipientAddress: alice.addressString }), /opening does not match/);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs, outputs: [{ address: alice.addressString, value: 999n }] }), /sum to the shielded total/);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs, outputs: [1, 2, 3, 4].map(() => ({ address: alice.addressString, value: 250n })) }), /n_out/);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs: [], recipientAddress: alice.addressString }), /n_in/);
  assert.throws(() => pool.buildShieldEnvelope({ asset: ASSET, inputs: mkInputs(9), recipientAddress: alice.addressString }), /n_in/);
  // Non-canonical shields: both parsers refuse.
  const { payload } = runs[0];
  const bl = runs[0].sh.body.length;
  for (const [label, mutate] of [
    ['trailing byte', (b) => cat(b, Uint8Array.of(0))],
    ['truncated', (b) => b.slice(0, -1)],
    ['n_in 0', (b) => { const c = Uint8Array.from(b); c[33] = 0; return c; }],
    ['n_in 9', (b) => { const c = Uint8Array.from(b); c[33] = 9; return c; }],
    ['n_out 0', (b) => { const c = Uint8Array.from(b); c[34] = 0; return c; }],
    ['n_out 4', (b) => { const c = Uint8Array.from(b); c[34] = 4; return c; }],
    ['zero leaf', (b) => { const c = Uint8Array.from(b); c.fill(0, 35, 67); return c; }],
    ['leaf ≥ p', (b) => { const c = Uint8Array.from(b); c.fill(0xff, 35, 67); return c; }],
    ['pk_eph prefix', (b) => { const c = Uint8Array.from(b); c[67] = 0x05; return c; }],
    ['C_secp prefix', (b) => { const c = Uint8Array.from(b); c[35 + POOL_NOTE_LEN] = 0x04; return c; }],
    ['proof_len 4097', (b) => { const c = Uint8Array.from(b.slice(0, bl + 64)); return cat(c, Uint8Array.of(0x01, 0x10), new Uint8Array(4097)); }],
    ['wrong opcode', (b) => { const c = Uint8Array.from(b); c[0] = T_BTC_SPEND; return c; }],
  ]) {
    const m = mutate(payload);
    assert.throws(() => pool.parseShield(m), undefined, label);
    assert.strictEqual(W.parseShield(m), null, label);
  }
  assert.throws(() => pool.assembleShield(runs[0].sh, new Uint8Array(BTC_POOL_MAX_PROOF + 1)), /too long/);
  // A boundary that does not verify is refused by payloadPublics.
  const badBd = Uint8Array.from(payload); badBd[35 + POOL_NOTE_LEN + 100] ^= 1;
  assert.throws(() => pool.payloadPublics(badBd), /boundary does not verify/);
}
ok('shield: layout 0x6C ‖ asset ‖ n_in ‖ n_out ‖ notes ‖ boundary ‖ kernel_sig ‖ proof_len LE ‖ proof; C_pool opens to (total, r_pool); kernel verifies independently under x(E), even and odd y; tamper fails; witness publics = wallet and indexer derivation; multi-output; non-canonical shields refused by both parsers');

// ── spend bodies ──
const SPK = '0x0014' + hex(rnd(20));
{
  const n1 = pool.createNote(bob.addressString, ASSET, 700n);
  const n2 = pool.createNote(bob.addressString, ASSET, 300n);
  const filler = pool.createNote(eve.addressString, ASSET, 1n);
  const tree = treeOf([filler.leaf, n1.leaf, n2.leaf]);
  const mine = pool.scan(bob, [filler, n1, n2].map((x, i) => ({ ...x, leafIndex: i }))).map((x) => ({ ...x, path: tree.path(x.leafIndex) }));
  assert.strictEqual(mine.length, 2);

  const pay = pool.buildSpendBody({ asset: ASSET, hAnchor: 250_000, root: tree.root, inputs: mine, outputs: [{ address: alice.addressString, value: 600n }, { address: bob.addressString, value: 400n }] });
  const parsed = pool.parseSpend(pay.body);
  assert.strictEqual(parsed.exit, null);
  assert.strictEqual(parsed.hAnchor, 250_000);
  assert.deepStrictEqual(parsed.nullifiers, pay.nullifiers);
  assert.deepStrictEqual(parsed.nullifiers, mine.map((m) => m.nf));
  const re = pool.encodeSpendBody({ asset: ASSET, hAnchor: parsed.hAnchor, nullifiers: parsed.nullifiers, outputs: parsed.outputs, exit: parsed.exit });
  assert.strictEqual(hex(re), hex(pay.body));
  assert.strictEqual(pay.body.length, 1 + 32 + 4 + 36 + 1 + 64 + 1 + 2 * POOL_NOTE_LEN + 1 + 1);
  assert.strictEqual(pay.body[0], T_BTC_SPEND);
  assert.deepStrictEqual([...pay.body.slice(33, 37)], [0x90, 0xd0, 0x03, 0x00]);
  assert.ok(pay.body.slice(37, 73).every((x) => x === 0), 'bind defaults to zero');
  assert.deepStrictEqual([pay.body[pay.body.length - 2], pay.body[pay.body.length - 1]], [0, 0]);
  assert.strictEqual(parsed.bind, null); assert.strictEqual(parsed.want, null);
  assert.deepStrictEqual(pool.scan(alice, parsed.outputs).map((x) => x.value), [600n]);
  assert.deepStrictEqual(pool.scan(bob, parsed.outputs).map((x) => x.value), [400n]);
  // Output ephemerals: e_j = Hs(domain ‖ nk_0 ‖ nf_0 ‖ j); a rebuild is byte-identical.
  pay.outputs.forEach((o, j) => assert.strictEqual(o.pkEph, '0x' + hex(compress(G.multiply(Hs(te.encode('tacit-btc-pool-zk-eph-v1'), unhex(mine[0].nkNote), unhex(mine[0].nf), Uint8Array.of(j)))))));
  const again = pool.buildSpendBody({ asset: ASSET, hAnchor: 250_000, inputs: mine, outputs: [{ address: alice.addressString, value: 600n }, { address: bob.addressString, value: 400n }] });
  assert.strictEqual(again.bodyHex, pay.bodyHex);
  assert.strictEqual(again.witness, null, 'no root, no witness');
  // Witness: publics = the indexer's derivation; EdDSA over bodyHash verifies under each Ak.
  const w = pay.witness;
  const full = pool.assembleSpendEnvelope(pay.body, FAKE_PROOF);
  const expect = spendPublics({ root: big(tree.root), body: pay.body, asset: unhex(ASSET), nullifiers: parsed.nullifiers.map(big), outLeaves: parsed.outputs.map((o) => big(o.leaf)) });
  assert.deepStrictEqual(w.publicSignals, expect);
  assert.deepStrictEqual(pool.payloadPublics(full, { root: tree.root }).publics, expect);
  assert.deepStrictEqual(workerPublics(full, tree.root), expect);
  assert.deepStrictEqual(publicSignals(w.input), expect);
  assert.throws(() => pool.payloadPublics(full), /root required/);
  assert.deepStrictEqual(w.input.nf, parsed.nullifiers.map((x) => String(big(x))));
  assert.deepStrictEqual(w.input.inV, ['700', '300']);
  assert.deepStrictEqual(w.input.outV, ['600', '400', '0']);
  assert.deepStrictEqual(w.input.exitC, ['0', '1']);
  for (let i = 0; i < 2; i++) {
    assert.ok(pool.zk.verify(w.input.inAk[i].map(BigInt), bodyHash(pay.body), { R8: w.input.sigR8[i].map(BigInt), S: BigInt(w.input.sigS[i]) }));
    assert.ok(!pool.zk.verify(w.input.inAk[i].map(BigInt), bodyHash(pay.body) + 1n, { R8: w.input.sigR8[i].map(BigInt), S: BigInt(w.input.sigS[i]) }));
  }
  JSON.parse(JSON.stringify(w.input));

  // Non-canonical bodies: the wallet parser throws, the indexer parser returns null.
  const nfOff = 74, outOff = 74 + 64 + 1;
  for (const [label, mutate, workerParses] of [
    ['trailing byte', (b) => cat(b, Uint8Array.of(0))],
    ['n_in 0', (b) => { const c = Uint8Array.from(b); c[73] = 0; return c; }],
    ['n_in 3', (b) => { const c = Uint8Array.from(b); c[73] = 3; return c; }],
    ['zero nullifier', (b) => { const c = Uint8Array.from(b); c.fill(0, nfOff, nfOff + 32); return c; }],
    ['nullifier ≥ p', (b) => { const c = Uint8Array.from(b); c.fill(0xff, nfOff, nfOff + 32); return c; }],
    ['repeated nullifier', (b) => { const c = Uint8Array.from(b); c.set(c.slice(nfOff, nfOff + 32), nfOff + 32); return c; }, 'worker parses, acceptSpend rejects'],
    ['n_out 4', (b) => { const c = Uint8Array.from(b); c[outOff - 1] = 4; return c; }],
    ['zero leaf', (b) => { const c = Uint8Array.from(b); c.fill(0, outOff, outOff + 32); return c; }],
    ['pk_eph off curve', (b) => { const c = Uint8Array.from(b); c[outOff + 32] = 0x07; return c; }],
    ['has_exit 2', (b) => { const c = Uint8Array.from(b); c[c.length - 2] = 2; return c; }],
    ['has_want 2', (b) => { const c = Uint8Array.from(b); c[c.length - 1] = 2; return c; }],
    ['has_want 1 without want', (b) => { const c = Uint8Array.from(b); c[c.length - 1] = 1; return c; }],
    ['no output, no exit', (b) => cat(b.slice(0, outOff - 1), Uint8Array.of(0, 0, 0))],
    ['truncated', (b) => b.slice(0, b.length - 1)],
    ['truncated in bind', (b) => b.slice(0, 60)],
    ['wrong opcode', (b) => { const c = Uint8Array.from(b); c[0] = T_BTC_SHIELD; return c; }],
  ]) {
    const m = mutate(pay.body);
    assert.throws(() => pool.parseSpend(m), undefined, label);
    if (!workerParses) assert.strictEqual(W.parseSpend(cat(m, Uint8Array.of(0, 0))), null, label);
  }
  assert.throws(() => pool.parseSpend(cat(pay.body, Uint8Array.of(5, 0, 9)), { full: true }), /truncated/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: mine, outputs: [{ address: alice.addressString, value: 999n }] }), /!= inputs/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, root: f32(1n), inputs: mine, outputs: [{ address: alice.addressString, value: 1000n }] }), /does not reach root/);
  assert.throws(() => pool.buildSpendBody({ asset: '0x' + 'cd'.repeat(32), hAnchor: 1, inputs: mine, outputs: [{ address: alice.addressString, value: 1000n }] }), /asset mismatch/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: [...mine, mine[0]], outputs: [{ address: alice.addressString, value: 1000n }] }), /n_in/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: [{ ...mine[0], leafIndex: undefined }], outputs: [{ address: alice.addressString, value: 700n }] }), /leafIndex/);

  // Pure exit: all 700 to SPK; the boundary carries C_secp = 700·H + r·G and exitC = pedersenBJJ(700, r_bjj).
  const ex = pool.buildSpendBody({ asset: ASSET, hAnchor: 7, root: tree.root, inputs: [mine[0]], exit: { exitVout: 2, scriptPubKey: SPK } });
  const pe = pool.parseSpend(ex.body);
  assert.strictEqual(pe.outputs.length, 0);
  assert.strictEqual(pe.exit.exitVout, 2);
  assert.strictEqual(pe.exit.destSpkHash, '0x' + hex(sha256(unhex(SPK))));
  assert.strictEqual(ex.exit.value, 700n);
  assert.ok(Pt.fromAffine({ x: big(pe.exit.cx), y: big(pe.exit.cy) }).equals(TACIT_H.multiply(700n).add(G.multiply(big(ex.exit.blinding)))));
  assert.deepStrictEqual([ex.exit.cx, ex.exit.cy], [pe.exit.cx, pe.exit.cy]);
  assert.strictEqual(ex.body.length, 1 + 32 + 4 + 36 + 1 + 32 + 1 + 1 + 4 + 32 + BOUNDARY_LEN + 1);
  const m0 = cat(unhex(mine[0].nkNote), unhex(mine[0].nf), Uint8Array.of(0, 0, 0, 2), unhex(pe.exit.destSpkHash));
  assert.strictEqual(big(ex.exit.blinding), Hs(te.encode('tacit-btc-pool-zk-exit-secp-v1'), m0));
  assert.strictEqual(big(ex.exit.rBjj), hsL('tacit-btc-pool-zk-exit-bjj-v1', m0));
  const exFull = pool.assembleSpendEnvelope(ex.body, FAKE_PROOF);
  const exPub = pool.payloadPublics(exFull, { root: tree.root }).publics;
  assert.deepStrictEqual(ex.witness.publicSignals, exPub);
  assert.deepStrictEqual(workerPublics(exFull, tree.root), exPub);
  assert.deepStrictEqual(exPub.slice(8, 10), pedersenBJJ(700n, big(ex.exit.rBjj)).map(String));
  assert.deepStrictEqual([ex.witness.input.exitV, ex.witness.input.exitR], ['700', String(big(ex.exit.rBjj))]);
  assert.deepStrictEqual(verifyBoundary(decodeBoundary(unhex(pe.exit.boundary))).map(String), exPub.slice(8, 10));

  // Partial exit with three outputs.
  const part = pool.buildSpendBody({ asset: ASSET, hAnchor: 8, root: tree.root, inputs: mine, outputs: [{ address: alice.addressString, value: 100n }, { address: bob.addressString, value: 200n }, { address: eve.addressString, value: 300n }], exit: { exitVout: 0, scriptPubKey: SPK } });
  const pp = pool.parseSpend(part.body);
  assert.strictEqual(pp.outputs.length, 3);
  assert.strictEqual(part.exit.value, 400n);
  assert.deepStrictEqual(part.witness.input.outV, ['100', '200', '300']);
  assert.strictEqual(part.witness.input.exitV, '400');
  assert.deepStrictEqual(part.witness.publicSignals, pool.payloadPublics(pool.assembleSpendEnvelope(part.body, FAKE_PROOF), { root: tree.root }).publics);
  assert.strictEqual('0x' + hex(pool.encodeSpendBody({ asset: ASSET, hAnchor: 8, nullifiers: pp.nullifiers, outputs: pp.outputs, exit: pp.exit })), part.bodyHex);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 8, inputs: mine, outputs: [1, 2, 3, 4].map(() => ({ address: alice.addressString, value: 250n })) }), /n_out/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 8, inputs: mine, outputs: [{ address: alice.addressString, value: 100n }], exit: { exitVout: 0, scriptPubKey: SPK, value: 1n } }), /!= inputs/);

  // proof_len LE, bounded.
  const proof = rnd(260);
  const fe = pool.assembleSpendEnvelope(ex.body, proof);
  assert.deepStrictEqual([...fe.slice(ex.body.length, ex.body.length + 2)], [260 & 0xff, 260 >> 8]);
  const pf = pool.parseSpend(fe, { full: true });
  assert.strictEqual(pf.proof, '0x' + hex(proof));
  assert.strictEqual(hex(pf.body), hex(ex.body));
  assert.throws(() => pool.assembleSpendEnvelope(ex.body, rnd(BTC_POOL_MAX_PROOF + 1)), /max/);
  const ws = W.parseSpend(fe);
  assert.strictEqual(hex(ws.body), hex(ex.body));
  assert.strictEqual(ws.exit.exitVout, 2);
  assert.strictEqual('0x' + hex(ws.exit.destSpkHash), pe.exit.destSpkHash);

  // bind and want on the wire: txid in input byte order, vout LE; want after the exit.
  const bindTxid = 'a1' + '00'.repeat(30) + 'ff';
  const payoutSpk = cat(Uint8Array.of(0x51, 0x20), rnd(32));
  const bw = pool.buildSpendBody({ asset: ASSET, hAnchor: 9, root: tree.root, inputs: mine, outputs: [{ address: alice.addressString, value: 250n }], exit: { exitVout: 0, scriptPubKey: SPK }, bind: { txid: bindTxid, vout: 5 }, want: { vout: 1, value: 12_345n, scriptPubKey: payoutSpk } });
  assert.deepStrictEqual([...bw.body.slice(37, 69)], [...unhex(bindTxid)].reverse(), 'bind txid in input byte order');
  assert.deepStrictEqual([...bw.body.slice(69, 73)], [5, 0, 0, 0]);
  const pw = pool.parseSpend(bw.body);
  assert.deepStrictEqual(pw.bind, { txid: bindTxid, vout: 5 });
  assert.deepStrictEqual(pw.want, { vout: 1, value: 12_345n, spkHash: '0x' + hex(sha256(payoutSpk)) });
  assert.deepStrictEqual(bw.want, pw.want);
  assert.strictEqual(bw.body[bw.body.length - 45], 1);
  assert.deepStrictEqual([...bw.body.slice(bw.body.length - 44, bw.body.length - 40)], [1, 0, 0, 0]);
  assert.deepStrictEqual([...bw.body.slice(bw.body.length - 40, bw.body.length - 32)], [0x39, 0x30, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual('0x' + hex(pool.encodeSpendBody({ asset: ASSET, hAnchor: 9, bind: pw.bind, nullifiers: pw.nullifiers, outputs: pw.outputs, exit: pw.exit, want: pw.want })), bw.bodyHex);
  assert.strictEqual(bw.exit.value, 750n, 'the want moves no pool value');
  const bwFull = pool.assembleSpendEnvelope(bw.body, FAKE_PROOF);
  assert.deepStrictEqual(pool.parseSpend(bwFull, { full: true }).want, pw.want);
  const wbw = W.parseSpend(bwFull);
  assert.deepStrictEqual(wbw.bind, { txid: bindTxid, vout: 5 });
  assert.deepStrictEqual([wbw.want.vout, wbw.want.value, '0x' + hex(wbw.want.spkHash)], [1, 12_345n, pw.want.spkHash]);
  assert.deepStrictEqual(bw.witness.publicSignals, workerPublics(bwFull, tree.root));
  for (const [label, args, re] of [
    ['want on the exit output', { want: { vout: 0, value: 1n, scriptPubKey: payoutSpk } }, /same output/],
    ['want value string', { want: { vout: 1, value: '5', scriptPubKey: payoutSpk } }, /want value/],
    ['want value fraction', { want: { vout: 1, value: 1.5, scriptPubKey: payoutSpk } }, /want value/],
    ['want value 2^64', { want: { vout: 1, value: 2n ** 64n, scriptPubKey: payoutSpk } }, /want value/],
    ['want value negative', { want: { vout: 1, value: -1n, scriptPubKey: payoutSpk } }, /want value/],
    ['want vout string', { want: { vout: '1', value: 1n, scriptPubKey: payoutSpk } }, /want vout/],
    ['want vout 2^32', { want: { vout: 2 ** 32, value: 1n, scriptPubKey: payoutSpk } }, /want vout/],
    ['want without script', { want: { vout: 1, value: 1n } }, /spkHash or scriptPubKey/],
    ['want hash mismatch', { want: { vout: 1, value: 1n, scriptPubKey: payoutSpk, spkHash: f32(0n) } }, /does not match/],
    ['want as a string', { want: 'x' }, /want must be/],
    ['bind vout string', { bind: { txid: bindTxid, vout: '5' } }, /bind vout/],
    ['bind vout negative', { bind: { txid: bindTxid, vout: -1 } }, /bind vout/],
    ['bind txid short', { bind: { txid: 'ab', vout: 1 } }, /32 bytes/],
    ['bind as a string', { bind: bindTxid + ':1' }, /bind must be/],
  ]) assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 9, inputs: mine, outputs: [{ address: alice.addressString, value: 250n }], exit: { exitVout: 0, scriptPubKey: SPK }, ...args }), re, label);
  const payWant = pool.buildSpendBody({ asset: ASSET, hAnchor: 9, inputs: mine, outputs: [{ address: alice.addressString, value: 1000n }], want: { vout: 0, value: 2 ** 53 - 1, spkHash: sha256(payoutSpk) } });
  assert.strictEqual(payWant.want.value, 2n ** 53n - 1n, 'a want on a pay, safe-integer value');
  assert.throws(() => pool.parseSpend(cat(bw.body.slice(0, bw.body.length - 45), Uint8Array.of(3), bw.body.slice(bw.body.length - 44))), /has_want/);
  assert.throws(() => pool.parseSpend(bw.body.slice(0, bw.body.length - 1)), /truncated/);
}
ok('spend body: canonical LE layout, parse/encode round-trip, deterministic ephemerals; witness publics = wallet and indexer derivation, EdDSA per input over bodyHash; exit opening and r_bjj from nk_0 ‖ nf_0; bind/want encoding; non-canonical bodies refused by both parsers');

// ── anchor policy ──
assert.strictEqual(pool.defaultAnchor, defaultAnchor);
assert.strictEqual(defaultAnchor(1000), 990);
assert.strictEqual(defaultAnchor(1002), 996);
assert.strictEqual(defaultAnchor(6), 0);
for (let t = 6; t < 400; t++) { const a = defaultAnchor(t); assert.ok(a % 6 === 0 && a <= t - 6 && a > t - 12, `tip ${t}`); assert.strictEqual(a, Math.floor((t - 6) / 6) * 6); }
for (const bad of [5, -1, 1.5, 2 ** 32, '1000', null]) assert.throws(() => defaultAnchor(bad));
ok('defaultAnchor(tip) = floor((tip − 6) / 6) · 6');

// ── wallet defaults ──
const carol = pool.walletFromSeed(rnd(32), 'signet');
{
  const n700 = pool.createNote(carol.addressString, ASSET, 700n);
  const nZero = pool.createNote(carol.internalAddress, ASSET, 0n, { network: 'signet' });
  const n300 = pool.createNote(carol.addressString, ASSET, 300n);
  const filler = pool.createNote(eve.addressString, ASSET, 1n);
  const tree = treeOf([filler.leaf, n700.leaf, nZero.leaf, n300.leaf]);
  const all = [filler, n700, nZero, n300].map((x, i) => ({ ...x, leafIndex: i }));
  const mine = pool.scan(carol, all).map((x) => ({ ...x, path: tree.path(x.leafIndex) }));
  assert.strictEqual(mine.length, 3);
  assert.deepStrictEqual(mine.map((x) => !!x.internal), [false, true, false]);
  assert.strictEqual(pool.scan(pool.viewWallet(carol), all).length, 2);

  const sel = pool.selectInputs(mine, 600n, { asset: ASSET });
  assert.deepStrictEqual(sel.inputs.map((x) => x.value), [700n, 0n]);
  assert.strictEqual(sel.total, 700n);
  assert.deepStrictEqual(pool.selectInputs(mine, 900n).inputs.map((x) => x.value), [700n, 300n]);
  assert.strictEqual(pool.selectInputs([mine[0], mine[0]], 5n).inputs.length, 1);
  assert.deepStrictEqual(pool.selectInputs([mine[2]], 5n).inputs.map((x) => x.value), [300n]);
  assert.throws(() => pool.selectInputs(mine, 1001n), /cannot cover/);
  assert.throws(() => pool.selectInputs(mine, 1n, { asset: '0x' + 'cd'.repeat(32) }), /no spendable/);
  assert.throws(() => pool.selectInputs(pool.scan(pool.viewWallet(carol), all), 1n), /no spendable/);
  assert.throws(() => pool.selectInputs(mine, -1n), /u64/);

  const TIP = 250_010;
  const pay = pool.buildSpendBody({ asset: ASSET, tip: TIP, root: tree.root, inputs: sel.inputs, outputs: [{ address: alice.addressString, value: 600n }], wallet: carol });
  const pp = pool.parseSpend(pay.body);
  assert.strictEqual(pp.nullifiers.length, 2);
  assert.strictEqual(pp.outputs.length, 3);
  assert.strictEqual(pp.hAnchor, defaultAnchor(TIP));
  assert.strictEqual(pay.hAnchor, 250_002);
  assert.deepStrictEqual(pay.witness.publicSignals, pool.payloadPublics(pool.assembleSpendEnvelope(pay.body, FAKE_PROOF), { root: tree.root }).publics);
  assert.deepStrictEqual(pool.scan(alice, pp.outputs).map((x) => x.value), [600n]);
  const outsIdx = pp.outputs.map((o, i) => ({ ...o, leafIndex: 100 + i }));
  const own = pool.scan(carol, outsIdx);
  assert.deepStrictEqual(own.map((x) => x.value).sort(), [0n, 100n]);
  assert.ok(own.every((x) => x.internal && x.nf && x.skNote));
  // Tiers over change and padding.
  assert.strictEqual(pool.scan(pool.viewWallet(carol), outsIdx).length, 0);
  const iv = pool.scan(pool.viewWallet(carol, { internal: true }), outsIdx);
  assert.deepStrictEqual(iv.map((x) => x.value), own.map((x) => x.value));
  assert.ok(iv.every((x) => x.internal && x.nf === undefined && x.skNote === undefined));
  const fv = pool.fullViewWallet(carol);
  const seen = pool.scan(fv, outsIdx);
  assert.deepStrictEqual(seen.map((x) => x.nf), own.map((x) => x.nf));
  assert.ok(seen.every((x) => x.skNote === undefined));
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: seen, outputs: [{ address: alice.addressString, value: 100n }], wallet: carol }), /not a spendable/);

  // Outputs are shuffled: Alice's slot moves across rebuilds.
  const slots = new Set();
  for (let i = 0; i < 12; i++) {
    const b = pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: sel.inputs, outputs: [{ address: alice.addressString, value: 600n }], wallet: carol });
    slots.add(pool.parseSpend(b.body).outputs.findIndex((o) => pool.tryReceive(alice, o)));
  }
  assert.ok(slots.size > 1 && !slots.has(-1), `alice slots ${[...slots]}`);

  const single = pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [mine[2]], outputs: [{ address: alice.addressString, value: 10n }], wallet: carol });
  assert.strictEqual(pool.parseSpend(single.body).outputs.length, 3);
  const nopad = pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [mine[2]], outputs: [{ address: alice.addressString, value: 10n }], wallet: carol, pad: false });
  assert.strictEqual(pool.parseSpend(nopad.body).outputs.length, 2);
  const exact = pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [mine[2]], outputs: [{ address: alice.addressString, value: 300n }], wallet: carol, pad: false });
  assert.strictEqual(pool.parseSpend(exact.body).outputs.length, 1, 'no change note when nothing is left');
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [mine[2]], outputs: [1, 2, 3].map(() => ({ address: alice.addressString, value: 10n })), wallet: carol }), /n_out/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [mine[2]], outputs: [{ address: alice.address, value: 300n }] }), /explicit network/);
  assert.ok(pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [mine[2]], outputs: [{ address: alice.address, value: 300n }], network: 'signet' }).body);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [mine[2]], outputs: [{ address: alice.addressString, value: 10n }], wallet: pool.walletFromScalars({ v: 1n, a: 2n, n: 3n }) }), /no internal address/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [mine[2]], outputs: [{ address: pool.walletFromSeed(rnd(32), 'mainnet').addressString, value: 10n }], wallet: carol }), /expected signet/);
}
ok('selectInputs pads to 2 inputs with a zero-value note; wallet pays default to 3 shuffled outputs with change and padding on the internal address; anchor from tip; v misses internal notes, (v, v_int) reads them, n adds nf');

// ── one real pay proof ──
const D = new URL('../dapp/btc-pool/', import.meta.url).pathname;
const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
const sys = makeGroth16System({ vk: JSON.parse(readFileSync(D + pin.vk, 'utf8')), wasm: readFileSync(D + pin.wasm), zkey: readFileSync(D + pin.zkey), pinnedVkHash: pin.vk_hash, snarkjs });
{
  assert.throws(() => makeGroth16System({ vk: JSON.parse(readFileSync(D + pin.vk, 'utf8')), pinnedVkHash: '00'.repeat(32) }), /not the pinned/);
  const dan = pool.walletFromSeed(rnd(32), 'signet');
  const a = pool.createNote(dan.addressString, ASSET, 5_000n), b = pool.createNote(dan.addressString, ASSET, 17n);
  const tree = treeOf([a.leaf, b.leaf]);
  const notes = pool.scan(dan, [a, b].map((x, i) => ({ ...x, leafIndex: i }))).map((x) => ({ ...x, path: tree.path(x.leafIndex) }));
  const { inputs } = pool.selectInputs(notes, 4_000n);
  const built = pool.buildSpendBody({ asset: ASSET, hAnchor: 600, root: tree.root, inputs, outputs: [{ address: bob.addressString, value: 4_000n }], wallet: dan });
  const stages = [];
  const t = performance.now();
  const { payload } = await pool.prove(built, sys, { onProgress: (s) => stages.push(s) });
  console.log(`    (pay proved in ${((performance.now() - t) / 1000).toFixed(1)} s, ${payload.length} bytes)`);
  assert.deepStrictEqual(stages, ['loading', 'proving']);
  assert.strictEqual(payload.length, built.body.length + 2 + 256);
  assert.ok(await pool.verifyPayload(sys, payload, { root: tree.root }));
  const { publics } = pool.payloadPublics(payload, { root: tree.root });
  assert.ok(await sys.verify(workerPublics(payload, tree.root), W.parseSpend(payload).proof));
  // Tampering: a body byte (bodyHash moves), a proof byte, another root.
  const tBody = Uint8Array.from(payload); tBody[built.body.length - 3] ^= 1;
  assert.ok(!(await pool.verifyPayload(sys, tBody, { root: tree.root })));
  const tProof = Uint8Array.from(payload); tProof[payload.length - 5] ^= 1;
  assert.ok(!(await pool.verifyPayload(sys, tProof, { root: tree.root })));
  assert.ok(!(await pool.verifyPayload(sys, payload, { root: f32(12345n) })));
  assert.ok(!(await sys.verify(publics.map((x, i) => (i === 1 ? String(BigInt(x) + 1n) : x)), W.parseSpend(payload).proof)));
  assert.ok(!(await pool.verifyPayload(sys, payload.slice(0, -1), { root: tree.root })));
  assert.deepStrictEqual(pool.scan(bob, pool.parseSpend(payload, { full: true }).outputs).map((x) => x.value), [4_000n]);
  // prove refuses a spend without witness and a system whose publics differ.
  await assert.rejects(pool.prove(pool.buildSpendBody({ asset: ASSET, hAnchor: 600, inputs, outputs: [{ address: bob.addressString, value: 5_017n }] }), sys), /no witness/);
  const liar = { prove: async (input) => ({ wire: FAKE_PROOF, publicSignals: publicSignals({ ...input, root: '1' }) }) };
  await assert.rejects(pool.prove(built, liar), /differ from the witness/);
}
ok('real Groth16 pay: proves with the pinned key, verifies natively against wallet and indexer publics; tampered body, proof, root and publics fail; prove needs a witness and matching publics');

// ── exit keys ──
{
  const k0 = pool.deriveExitKey(carol, 0), k0b = pool.deriveExitKey(carol, 0), k1 = pool.deriveExitKey(carol, 1);
  assert.deepStrictEqual(k0, k0b);
  assert.notStrictEqual(k0.scriptPubKey, k1.scriptPubKey);
  const d = Hs(te.encode('tacit-btc-pool-exit-key-v1'), unhex(carol.exitRoot), Uint8Array.of(0, 0, 0, 0));
  assert.strictEqual(k0.priv, f32(d));
  const spk = unhex(k0.scriptPubKey);
  assert.strictEqual(spk.length, 34); assert.strictEqual(spk[0], 0x51); assert.strictEqual(spk[1], 0x20);
  const P = Pt.fromHex(k0.pub.slice(2));
  assert.ok(P.equals(G.multiply(d)));
  const px = compress(P).slice(1);
  const th = (tag, m) => { const t = sha256(te.encode(tag)); return sha256(cat(t, t, m)); };
  const Q = Pt.fromHex('02' + hex(px)).add(G.multiply(big(hex(th('TapTweak', px))) % N));
  assert.strictEqual(hex(compress(Q).slice(1)), hex(spk.slice(2)));
  assert.strictEqual(hex(compress(G.multiply(big(k0.outputPriv))).slice(1)), hex(spk.slice(2)));
  assert.strictEqual(k0.destSpkHash, '0x' + hex(sha256(spk)));
  const w = pool.deriveExitKey(carol, 0, 'p2wpkh');
  assert.strictEqual(w.scriptPubKey, '0x0014' + hex(ripemd160(sha256(unhex(w.pub)))));
  assert.throws(() => makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 }).deriveExitKey(carol, 0, 'p2wpkh'), /ripemd160/);
  assert.throws(() => pool.deriveExitKey(carol, 0, 'p2sh'), /unknown exit key type/);
  assert.throws(() => pool.deriveExitKey(pool.viewWallet(carol), 0));
  assert.throws(() => pool.deriveExitKey(carol, -1));

  const nt = pool.createNote(carol.addressString, ASSET, 50n);
  const [owned] = pool.scan(carol, [{ ...nt, leafIndex: 7 }]);
  const used = new Set();
  const f0 = pool.freshExitKey(carol, used);
  assert.strictEqual(f0.counter, 0);
  pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [owned], exit: { exitVout: 0, scriptPubKey: f0.scriptPubKey }, usedScripts: used });
  assert.ok(used.has(f0.destSpkHash));
  for (const args of [
    { usedScripts: used },
    { usedScripts: [f0.scriptPubKey] },
    { usedScripts: [f0.destSpkHash.toUpperCase().replace('0X', '0x')] },
    { wallet: { ...carol, usedScripts: used } },
  ]) assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [owned], exit: { exitVout: 0, scriptPubKey: f0.scriptPubKey }, ...args }), /already used/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [owned], exit: { exitVout: 0, destSpkHash: f0.destSpkHash }, usedScripts: used }), /already used/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 12, inputs: [owned], exit: { exitVout: 0, scriptPubKey: f0.scriptPubKey, destSpkHash: k1.destSpkHash } }), /does not match/);
  assert.strictEqual(pool.freshExitKey(carol, used).counter, 1);
  assert.strictEqual(pool.freshExitKey(carol, [k0.scriptPubKey, k1.scriptPubKey]).counter, 2);
  assert.strictEqual(pool.freshExitKey(carol, used, { from: 5 }).counter, 5);
  assert.strictEqual(pool.freshExitKey(carol, null, { type: 'p2wpkh' }).scriptPubKey, w.scriptPubKey);
}
ok('exit keys: seed + counter → BIP-86 P2TR (tweak checked independently) or P2WPKH; a used exit script (script, hash, any case) is refused and the next fresh key skips it');

// ── h_anchor / exit_vout / repeats ──
{
  const nt = pool.createNote(carol.addressString, ASSET, 50n);
  const [owned] = pool.scan(carol, [{ ...nt, leafIndex: 8 }]);
  const outs = [{ address: alice.addressString, value: 50n }];
  for (const bad of [1.5, -1, 2 ** 32, '5', 5n, NaN]) {
    assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: bad, inputs: [owned], outputs: outs }), /h_anchor/, String(bad));
    assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: [owned], exit: { exitVout: bad, scriptPubKey: SPK } }), /exit_vout/, String(bad));
  }
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, inputs: [owned], outputs: outs }), /h_anchor or tip/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, h_anchor: 5, inputs: [owned], outputs: outs }), /h_anchor or tip/);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: [owned], exit: { exit_vout: 1, scriptPubKey: SPK } }), /exit_vout/);
  const maxA = pool.buildSpendBody({ asset: ASSET, hAnchor: 2 ** 32 - 1, inputs: [owned], outputs: outs });
  assert.strictEqual(pool.parseSpend(maxA.body).hAnchor, 2 ** 32 - 1);
  assert.throws(() => pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: [owned, { ...owned }], outputs: [{ address: alice.addressString, value: 100n }] }), /repeated input/);
  const nf = owned.nf;
  const good = pool.buildSpendBody({ asset: ASSET, hAnchor: 1, inputs: [owned], outputs: outs });
  assert.throws(() => pool.encodeSpendBody({ asset: ASSET, hAnchor: 1, nullifiers: [nf, nf.toUpperCase().replace('0X', '0x')], outputs: good.outputs }), /repeated nullifier/);
  assert.throws(() => pool.encodeSpendBody({ asset: ASSET, hAnchor: -1, nullifiers: [nf], outputs: good.outputs }), /h_anchor/);
  assert.throws(() => pool.encodeSpendBody({ asset: ASSET, hAnchor: 1, nullifiers: [nf], outputs: [] }), /output or an exit/);
  assert.throws(() => pool.encodeSpendBody({ asset: ASSET, hAnchor: 1, nullifiers: [], outputs: good.outputs }), /n_in/);
}
ok('h_anchor and exit_vout must be integers in [0, 2^32) (no coercion, no aliases); repeated inputs or nullifiers are rejected');

// ── exit recovery from seed and chain data ──
{
  const seedD = rnd(32);
  const dave = pool.walletFromSeed(seedD, 'signet');
  const a1 = pool.createNote(dave.addressString, ASSET, 1_000n), a2 = pool.createNote(dave.addressString, ASSET, 234n);
  const tree = treeOf([a1.leaf, a2.leaf]);
  const inputs = pool.scan(dave, [a1, a2].map((x, i) => ({ ...x, leafIndex: i }))).map((x) => ({ ...x, path: tree.path(x.leafIndex) }));
  const pure = pool.buildSpendBody({ asset: ASSET, hAnchor: 90, root: tree.root, inputs, exit: { exitVout: 1, scriptPubKey: pool.deriveExitKey(dave, 0).scriptPubKey } });
  const partialArgs = { asset: ASSET, hAnchor: 90, root: tree.root, inputs, outputs: [{ address: alice.addressString, value: 100n }, { address: dave.addressString, value: 34n }], exit: { exitVout: 0, scriptPubKey: pool.deriveExitKey(dave, 1).scriptPubKey } };
  const partial = pool.buildSpendBody(partialArgs);
  const payload = pool.assembleSpendEnvelope(partial.body, FAKE_PROOF);

  // Only the seed and public chain data from here on.
  const fresh = pool.walletFromSeed(seedD, 'signet');
  const chainNotes = [a1, a2].map((x, i) => ({ asset: x.asset, leaf: x.leaf, pkEph: x.pkEph, ctNote: x.ctNote, leafIndex: i }));
  const scanned = pool.scan(fresh, chainNotes);
  const r1 = pool.recoverExit(fresh, pure.body, scanned);
  assert.deepStrictEqual([r1.value, r1.blinding, r1.exitVout, r1.cx, r1.cy], [1_234n, pure.exit.blinding, 1, pure.exit.cx, pure.exit.cy]);
  const r2 = pool.recoverExit(fresh, payload, scanned);
  assert.deepStrictEqual([r2.value, r2.blinding, r2.destSpkHash], [1_100n, partial.exit.blinding, partial.exit.destSpkHash]);
  // Alice's output opened through `addresses`, no search.
  assert.strictEqual(pool.recoverExit(fresh, partial.body, scanned, { addresses: [alice.addressString], maxSearch: 0 }).value, 1_100n);
  assert.throws(() => pool.recoverExit(fresh, partial.body, scanned, { addresses: [eve.addressString], maxSearch: 0 }), /not recovered/);
  assert.throws(() => pool.recoverExit(fresh, partial.body, scanned, { maxSearch: 50 }), /not recovered/);
  assert.throws(() => pool.recoverExit(fresh, partial.body, []), /not among/);
  assert.throws(() => pool.recoverExit(eve, partial.body, pool.scan(eve, chainNotes)), /not among/);
  assert.throws(() => pool.recoverExit(eve, partial.body, scanned.map((x) => ({ ...x, nkNote: f32(big(x.nkNote) + 1n) }))), /not recovered/);
  const payOnly = pool.buildSpendBody({ asset: ASSET, hAnchor: 90, inputs, outputs: [{ address: alice.addressString, value: 1_234n }] });
  assert.throws(() => pool.recoverExit(fresh, payOnly.body, scanned), /no exit/);
  // Deterministic: the same spend rebuilt is byte-identical, so a retry reveals nothing new.
  const again = pool.buildSpendBody({ ...partialArgs, root: undefined });
  assert.strictEqual(again.exit.blinding, partial.exit.blinding);
  assert.deepStrictEqual(again.outputs.map((o) => o.pkEph), partial.outputs.map((o) => o.pkEph));
  assert.strictEqual(again.exit.cx, partial.exit.cx);
  // A spend from other inputs gets a different opening.
  const other = pool.buildSpendBody({ ...partialArgs, root: undefined, inputs: [inputs[1], inputs[0]] });
  assert.notStrictEqual(other.exit.blinding, partial.exit.blinding);
}
ok('exit opening recovered from the seed and the on-chain body (pure exit; partial exit via addresses or bounded search); a rebuild of the same spend is byte-identical, another input order is not');

// ── vectors ──
const VEC = new URL('./vectors/btc-pool-wallet-vectors.json', import.meta.url).pathname;
{
  const S = (x) => String(x);
  const vseed = new Uint8Array(32).fill(1);
  const walletVec = (net) => {
    const w = pool.walletFromSeed(vseed, net);
    const k = pool.deriveExitKey(w, 0);
    return { network: net, v: w.v, vInt: w.vInt, a: w.a, n: w.n, exitRoot: w.exitRoot, V: w.V, VInt: w.VInt, A: w.A, N: w.N, address: w.address, internalAddress: w.internalAddress, addressString: w.addressString, exitKey0: { priv: k.priv, scriptPubKey: k.scriptPubKey, outputKey: k.outputKey } };
  };
  const vAlice = pool.walletFromSeed(vseed, 'signet');
  const vBob = pool.walletFromSeed(new Uint8Array(32).fill(2), 'signet');
  const e = 0x1234567890abcdefn;
  const vn = pool.createNote(vBob.addressString, ASSET, 123_456_789n, { e });
  const vr = pool.scan(vBob, [{ ...vn, leafIndex: 5 }])[0];
  const x1 = pool.createNote(vAlice.addressString, ASSET, 1_000n, { e: 11n }), x2 = pool.createNote(vAlice.addressString, ASSET, 234n, { e: 12n });
  const tree = treeOf([f32(7n), x1.leaf, x2.leaf]);
  const ins = pool.scan(vAlice, [x1, x2].map((x, i) => ({ ...x, leafIndex: i + 1 }))).map((x) => ({ ...x, path: tree.path(x.leafIndex) }));
  const sp = pool.buildSpendBody({ asset: ASSET, hAnchor: 144, root: tree.root, inputs: ins, outputs: [{ address: vBob.addressString, value: 900n }, { address: vAlice.internalAddress, network: 'signet', value: 334n }], bind: { txid: 'cd'.repeat(32), vout: 3 }, want: { vout: 1, value: 5_000n, scriptPubKey: '0x0014' + '22'.repeat(20) } });
  const det = {
    note: 'Generated by tests/btc-pool-wallet.test.mjs (REGEN=1). Hex with 0x; field elements and values decimal.',
    asset: ASSET,
    wallets: [walletVec('signet'), walletVec('mainnet')],
    note_to_bob: { seed_bob: '0x' + '02'.repeat(32), e: S(e), value: '123456789', leaf: vn.leaf, pkEph: vn.pkEph, ctNote: vn.ctNote, npk: vn.npk, rho: vn.rho, leafIndex: 5, nkNote: vr.nkNote, skNote: vr.skNote, ak: vr.ak, nf: vr.nf },
    pay: { root: tree.root, hAnchor: 144, body: sp.bodyHex, bodyHash: S(bodyHash(sp.body)), nullifiers: sp.nullifiers, publicSignals: sp.witness.publicSignals },
  };
  if (process.env.REGEN || !existsSync(VEC)) {
    writeFileSync(VEC, JSON.stringify(det, null, 1) + '\n');
    ok(`wrote ${VEC}`);
  } else {
    const stored = JSON.parse(readFileSync(VEC, 'utf8'));
    for (const k of Object.keys(det)) assert.deepStrictEqual(stored[k], det[k], `vector field ${k}`);
    // The stored body parses on both sides and its publics re-derive.
    const full = pool.assembleSpendEnvelope(unhex(stored.pay.body), FAKE_PROOF);
    assert.deepStrictEqual(pool.payloadPublics(full, { root: stored.pay.root }).publics, stored.pay.publicSignals);
    assert.deepStrictEqual(workerPublics(full, stored.pay.root), stored.pay.publicSignals);
    for (const wv of stored.wallets) assert.strictEqual('0x' + hex(pool.decodeAddress(wv.addressString, wv.network).bytes), wv.address);
    ok('stored wallet vectors (keys, addresses, exit key, note, pay body and publics) match');
  }
}

console.log(`\n${n} passed in ${((performance.now() - T0) / 1000).toFixed(1)} s`);
process.exit(0);
