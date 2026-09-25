// Bitcoin-native shielded pool (DESIGN-btc-shielded-pool.md) — Phase 3 indexer wiring tests.
// Covers §10 acceptance-order logic (canonical parse, tree/nullifier bookkeeping, the shield-time
// opening-proof check, the exit-time value/destination check against synthetic chain data) WITHOUT real
// proof verification, since no SP1 guest/verifying key exists yet (see worker/src/btc-shielded-pool.js's
// `verifyBtcPoolSpendProof` stub comment). Mirrors the plain node:assert style of tests/cbtc-envelope.mjs.
// Run: node tests/btc-shielded-pool.test.mjs
import assert from 'node:assert';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  T_BTC_SHIELD, T_BTC_SPEND, BTC_POOL_OUT_PAY, BTC_POOL_OUT_EXIT,
  parseBtcShieldEnvelope, parseBtcSpendEnvelope, parseBtcPoolEnvelope,
  btcPoolNoteLeaf, btcPoolNfSecret, btcPoolNullifier,
  verifyBtcShieldOpeningProof,
  BtcPoolTree, btcPoolMerkleRootFrom,
  makeBtcShieldedPoolState, acceptBtcShieldEnvelope, acceptBtcSpendEnvelope,
  commitBtcPoolBlockRoot, rollbackBtcPoolFromHeight,
  verifyBtcPoolSpendProof, BTC_POOL_ANCHOR_WINDOW,
} from '../worker/src/btc-shielded-pool.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// The dapp module exports a DI factory (same convention as dapp/confidential-pool.js), not bare
// functions — instantiate once here so the envelope-builder tests below can call its methods directly.
const _sha256Placeholder = (b) => keccak_256(b); // unused by any path under test; only openMemo-style code needs a real sha256
const dappPool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256: _sha256Placeholder });
const { buildBtcShieldEnvelope, buildBtcSpendEnvelope } = dappPool;

const ASSET = '0x' + 'ab'.repeat(32);
const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const zero32 = '0x' + '00'.repeat(32);
const rand32 = () => '0x' + Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');

// A NUMS-ish H for tests (not the real cxfer-core H — see worker/src/btc-shielded-pool.js's comment on
// why the real generator is not baked into this module; tests supply their own consistent H).
const H = secp.ProjectivePoint.fromPrivateKey(hexToBytes('0x' + '07'.repeat(32)));

// ────────────────────────────────────────────────────────────────────────────
// Envelope builders (dapp) round-trip through the canonical parsers (worker)
// ────────────────────────────────────────────────────────────────────────────
{
  const env = buildBtcShieldEnvelope({
    asset: ASSET, lockVout: 1, cx: rand32(), cy: rand32(), pkEph: rand32(), spendKey: rand32(),
    openingProof: '0x' + '11'.repeat(64),
  });
  const bytes = hexToBytes(env);
  assert.equal(bytes.length, 229, 'shield envelope is 229 bytes');
  const p = parseBtcShieldEnvelope(env);
  assert.ok(p, 'parser accepts the built shield envelope');
  assert.equal(p.type, 'btc_shield');
  assert.equal(p.lockVout, 1);
  ok('buildBtcShieldEnvelope round-trips through parseBtcShieldEnvelope');
}

{
  assert.throws(() => buildBtcShieldEnvelope({ asset: ASSET, lockVout: 0, cx: rand32(), cy: rand32(), pkEph: rand32(), spendKey: rand32(), openingProof: '0x' + '00'.repeat(64) }),
    /lock_vout must be/, 'vout-0 shield is rejected at build time');
  ok('shield envelope builder rejects lock_vout = 0');
}

{
  const nf1 = rand32();
  const out = { cx: rand32(), cy: rand32(), pkEph: rand32(), spendKey: rand32(), ctNote: '0x' + '22'.repeat(56) };
  const env = buildBtcSpendEnvelope({ asset: ASSET, nullifiers: [nf1], outKind: BTC_POOL_OUT_PAY, outputs: [out], hAnchor: 900_000, proof: '0x' + '33'.repeat(10) });
  const p = parseBtcSpendEnvelope(env);
  assert.ok(p, 'parser accepts the built pay envelope');
  assert.equal(p.outKind, BTC_POOL_OUT_PAY);
  assert.equal(p.nullifiers.length, 1);
  assert.equal(p.nullifiers[0].toLowerCase(), nf1.toLowerCase());
  assert.equal(p.outputs.length, 1);
  assert.equal(p.hAnchor, 900_000);
  ok('buildBtcSpendEnvelope (pay) round-trips through parseBtcSpendEnvelope');
}

{
  const nf1 = rand32();
  const env = buildBtcSpendEnvelope({
    asset: ASSET, nullifiers: [nf1], outKind: BTC_POOL_OUT_EXIT,
    exitVout: 2, exitValue: 123456n, destSpkHash: rand32(), hAnchor: 900_100, proof: '0x' + '44'.repeat(20),
  });
  const p = parseBtcSpendEnvelope(env);
  assert.equal(p.outKind, BTC_POOL_OUT_EXIT);
  assert.equal(p.exitVout, 2);
  assert.equal(p.exitValue, '123456');
  ok('buildBtcSpendEnvelope (exit) round-trips through parseBtcSpendEnvelope');
}

// ── canonical-parse rejections (§10 step 1: fixed widths, counts match, no trailing bytes) ──
{
  assert.equal(parseBtcShieldEnvelope('0x' + '6c' + '00'.repeat(228 - 1)), null, 'one byte short is rejected');
  assert.equal(parseBtcShieldEnvelope('0x' + '6c' + '00'.repeat(229)), null, 'one byte long is rejected');
  assert.equal(parseBtcShieldEnvelope('0x' + '6d' + '00'.repeat(228)), null, 'wrong opcode byte is rejected');
  ok('parseBtcShieldEnvelope rejects malformed lengths/opcode');
}
{
  // n_in = 0
  const bad = '0x' + '6d' + ASSET.slice(2) + '00' + '00' /* out_kind */ + '00'.repeat(4) /* h_anchor */;
  assert.equal(parseBtcSpendEnvelope(bad), null, 'n_in = 0 is rejected');
  // n_in = 3 (over BTC_POOL_MAX_IN)
  const bad2 = '0x' + '6d' + ASSET.slice(2) + '03' + rand32().slice(2).repeat(3) + '00' + '00'.repeat(4);
  assert.equal(parseBtcSpendEnvelope(bad2), null, 'n_in = 3 is rejected (over max)');
  ok('parseBtcSpendEnvelope rejects out-of-range arity');
}
{
  const nf = rand32();
  // Two identical nullifiers within one envelope must be rejected at parse time (§10 step 3, the
  // within-envelope half; the against-replayed-set half is acceptBtcSpendEnvelope's job below).
  const env = buildBtcSpendEnvelope({
    asset: ASSET, nullifiers: [nf, rand32()], outKind: BTC_POOL_OUT_EXIT,
    exitVout: 0, exitValue: 1n, destSpkHash: rand32(), hAnchor: 1, proof: '0x',
  });
  // Hand-corrupt the second nullifier to equal the first, bypassing the builder's own distinctness guard.
  const bytes = hexToBytes(env);
  const nfStart = 1 + 32 + 1; // opcode, asset, n_in
  bytes.set(bytes.slice(nfStart, nfStart + 32), nfStart + 32); // duplicate nf[0] into nf[1]
  const p = parseBtcSpendEnvelope(bytes);
  assert.equal(p, null, 'a repeated nullifier within one envelope is rejected at parse time');
  ok('parseBtcSpendEnvelope rejects a repeated nullifier within one envelope');
}

// ────────────────────────────────────────────────────────────────────────────
// leaf / nullifier formulas
// ────────────────────────────────────────────────────────────────────────────
{
  const cx = rand32(), cy = rand32(), spendKey = rand32(), skNote = rand32();
  const leaf = btcPoolNoteLeaf(ASSET, cx, cy, spendKey);
  const nfSecret = btcPoolNfSecret(skNote);
  const nf = btcPoolNullifier(leaf, nfSecret);
  // A passive observer knowing only the public leaf preimage cannot compute the real nullifier — the old,
  // wrong formula (Bitcoin-homed notes' keccak(leaf‖"spent")) must differ.
  const observerGuess = '0x' + Buffer.from(keccak_256(hexToBytes(leaf + 'spent'.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')))).toString('hex');
  assert.notEqual(nf.toLowerCase(), observerGuess.toLowerCase(), 'nullifier must not be precomputable from leaf alone');
  ok('btcPoolNullifier is not precomputable from public leaf fields alone');
}

// ────────────────────────────────────────────────────────────────────────────
// BtcPoolTree / merkle round-trip
// ────────────────────────────────────────────────────────────────────────────
{
  const tree = new BtcPoolTree();
  const leaves = [rand32(), rand32(), rand32()];
  for (const l of leaves) tree.insert(l);
  const { root, path } = tree.rootAndPath(1);
  assert.equal(btcPoolMerkleRootFrom(leaves[1], 1, path), root, 'merkle path for a real leaf reconstructs the tree root');
  ok('BtcPoolTree / btcPoolMerkleRootFrom round-trip');
}

// ────────────────────────────────────────────────────────────────────────────
// Shield-time opening-proof check (§10 step 2)
// ────────────────────────────────────────────────────────────────────────────
{
  // Build a real Schnorr NIZK the way a wallet would, using the module's own relation directly (there is
  // no separate "prove" export — the verify function's relation is exercised by hand-building a valid
  // proof here, matching worker/src/btc-shielded-pool.js's documented construction exactly).
  const N = secp.CURVE.n;
  const G = secp.ProjectivePoint.BASE;
  const value = 50_000n;
  const r = BigInt('0x' + '09'.repeat(32)) % N;
  const C = H.multiply(value).add(G.multiply(r));
  const cx = '0x' + C.toAffine().x.toString(16).padStart(64, '0');
  const cy = '0x' + C.toAffine().y.toString(16).padStart(64, '0');
  // The prover must canonicalize k so R=k·G has even y before hashing (same x-only-encoding requirement
  // as sk_note's even-y canonicalization elsewhere in this design) — R is only ever carried as its
  // x-coordinate in the 64-byte proof, so the verifier's reconstruction assumes even y.
  let kScalar = BigInt('0x' + '0a'.repeat(32)) % N;
  let R = G.multiply(kScalar);
  if (R.toRawBytes(true)[0] !== 0x02) { kScalar = (N - kScalar) % N; R = G.multiply(kScalar); }
  const rX = R.toRawBytes(true).slice(1);
  const domain = new TextEncoder().encode('tacit-btc-pool-opening-v1');
  const vBe8 = (() => { const b = new Uint8Array(8); let v = value; for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; })();
  const cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  const e = BigInt('0x' + Buffer.from(keccak_256(cat([domain, hexToBytes(cx), hexToBytes(cy), vBe8, rX]))).toString('hex')) % N;
  const s = (kScalar + e * r) % N;
  const sBytes = hexToBytes('0x' + s.toString(16).padStart(64, '0'));
  const proof = '0x' + Buffer.from(rX).toString('hex') + Buffer.from(sBytes).toString('hex');

  const hPointHex = '0x' + H.toRawBytes(true).slice(1).length; // placeholder guard below always passes a real hex
  const hHex = '0x' + Buffer.from(H.toRawBytes(true)).toString('hex');

  const good = verifyBtcShieldOpeningProof({ cxHex: cx, cyHex: cy, valueSats: value, openingProofHex: proof, hPointHex: hHex });
  assert.equal(good, true, 'a correctly constructed opening proof verifies');
  ok('verifyBtcShieldOpeningProof accepts a valid proof');

  const wrongValue = verifyBtcShieldOpeningProof({ cxHex: cx, cyHex: cy, valueSats: value + 1n, openingProofHex: proof, hPointHex: hHex });
  assert.equal(wrongValue, false, 'an opening proof does not verify against the wrong claimed value');
  ok('verifyBtcShieldOpeningProof rejects a mismatched value');

  assert.throws(() => verifyBtcShieldOpeningProof({ cxHex: cx, cyHex: cy, valueSats: value, openingProofHex: proof }), /requires the real Pedersen H/, 'missing H throws rather than silently using a wrong default');
  ok('verifyBtcShieldOpeningProof refuses to guess H');

  // Full acceptBtcShieldEnvelope path against synthetic chain data.
  const env = buildBtcShieldEnvelope({ asset: ASSET, lockVout: 1, cx, cy, pkEph: rand32(), spendKey: rand32(), openingProof: proof });
  const parsed = parseBtcShieldEnvelope(env);
  const state = makeBtcShieldedPoolState();
  const chainCtx = { txOutputs: [{ valueSats: 0n }, { valueSats: value }] }; // vout 1 = the lock, value = 50000
  const res = acceptBtcShieldEnvelope(state, parsed, { chainCtx, hPointHex: hHex });
  assert.equal(res.accepted, true, 'a shield envelope with a matching opening proof + real output value is accepted');
  assert.equal(state.tree.leaves.length, 1, 'accepted shield appends exactly one leaf');
  ok('acceptBtcShieldEnvelope accepts a valid shield against synthetic chain data');

  const state2 = makeBtcShieldedPoolState();
  const wrongCtx = { txOutputs: [{ valueSats: 0n }, { valueSats: value + 1n }] }; // real output value differs from what the proof commits to
  const res2 = acceptBtcShieldEnvelope(state2, parsed, { chainCtx: wrongCtx, hPointHex: hHex });
  assert.equal(res2.accepted, false, 'a shield whose real lock output value disagrees with the opening proof is rejected');
  assert.equal(state2.tree.leaves.length, 0, 'a rejected shield mutates nothing (§10: a rejected envelope mutates nothing)');
  ok('acceptBtcShieldEnvelope rejects + mutates nothing when the real chain value disagrees');

  const state3 = makeBtcShieldedPoolState();
  const missingVoutCtx = { txOutputs: [{ valueSats: 0n }] }; // lockVout=1 doesn't exist
  const res3 = acceptBtcShieldEnvelope(state3, parsed, { chainCtx: missingVoutCtx, hPointHex: hHex });
  assert.equal(res3.accepted, false, 'a shield whose lock_vout is not a real output is rejected');
  ok('acceptBtcShieldEnvelope rejects a shield whose lock_vout does not name a real output');
}

// ────────────────────────────────────────────────────────────────────────────
// Exit-time value/destination check against synthetic chain data (§10 step 2a)
// ────────────────────────────────────────────────────────────────────────────
{
  const destSpkHash = rand32();
  const nf = rand32();
  const env = buildBtcSpendEnvelope({ asset: ASSET, nullifiers: [nf], outKind: BTC_POOL_OUT_EXIT, exitVout: 1, exitValue: 77_000n, destSpkHash, hAnchor: 100, proof: '0x' + 'aa'.repeat(4) });
  const parsed = parseBtcSpendEnvelope(env);

  // Give it a retained root at h_anchor so it clears step 4 (proof will still fail step 5's stub, so use
  // a permissive verifyProof injection for the parts of this test that aren't about step 2a itself).
  const alwaysAccept = () => true;

  const state = makeBtcShieldedPoolState();
  commitBtcPoolBlockRoot(state, 100);
  const goodCtx = { txOutputs: [{ valueSats: 0n }, { valueSats: 77_000n, scriptPubKeyHash: destSpkHash }] };
  const res = await acceptBtcSpendEnvelope(state, parsed, { chainCtx: goodCtx, verifyProof: alwaysAccept });
  assert.equal(res.accepted, true, 'exit accepted when real output value AND destination both match');
  assert.ok(state.nullifierSet.has(nf.toLowerCase()), 'accepted exit inserts its nullifier');
  ok('acceptBtcSpendEnvelope (exit) accepts when both value and destination match real chain data');

  const state2 = makeBtcShieldedPoolState();
  commitBtcPoolBlockRoot(state2, 100);
  const wrongValueCtx = { txOutputs: [{ valueSats: 0n }, { valueSats: 76_999n, scriptPubKeyHash: destSpkHash }] };
  const res2 = await acceptBtcSpendEnvelope(state2, parsed, { chainCtx: wrongValueCtx, verifyProof: alwaysAccept });
  assert.equal(res2.accepted, false, 'exit rejected when real output value disagrees with exit_value');
  assert.equal(state2.nullifierSet.size, 0, 'a rejected exit mutates nothing');
  ok('acceptBtcSpendEnvelope (exit) rejects a value mismatch and mutates nothing');

  const state3 = makeBtcShieldedPoolState();
  commitBtcPoolBlockRoot(state3, 100);
  const wrongDestCtx = { txOutputs: [{ valueSats: 0n }, { valueSats: 77_000n, scriptPubKeyHash: rand32() }] };
  const res3 = await acceptBtcSpendEnvelope(state3, parsed, { chainCtx: wrongDestCtx, verifyProof: alwaysAccept });
  assert.equal(res3.accepted, false, 'exit rejected when real output scriptPubKey disagrees with dest_spk_hash — value-correct, recipient-wrong is still rejected');
  ok('acceptBtcSpendEnvelope (exit) rejects a destination mismatch even when the value matches');
}

// ────────────────────────────────────────────────────────────────────────────
// Nullifier-set / double-spend bookkeeping (§10 step 3)
// ────────────────────────────────────────────────────────────────────────────
{
  const nf = rand32();
  const env = buildBtcSpendEnvelope({ asset: ASSET, nullifiers: [nf], outKind: BTC_POOL_OUT_EXIT, exitVout: 0, exitValue: 1n, destSpkHash: rand32(), hAnchor: 5, proof: '0x' });
  const parsed = parseBtcSpendEnvelope(env);
  const state = makeBtcShieldedPoolState();
  commitBtcPoolBlockRoot(state, 5);
  const ctx = { txOutputs: [{ valueSats: 1n, scriptPubKeyHash: parsed.destSpkHash }] };
  const alwaysAccept = () => true;

  const first = await acceptBtcSpendEnvelope(state, parsed, { chainCtx: ctx, verifyProof: alwaysAccept });
  assert.equal(first.accepted, true, 'first spend of a nullifier is accepted');
  const replay = await acceptBtcSpendEnvelope(state, parsed, { chainCtx: ctx, verifyProof: alwaysAccept });
  assert.equal(replay.accepted, false, 'replaying the same nullifier a second time is rejected');
  assert.match(replay.reason, /already spent/);
  ok('acceptBtcSpendEnvelope rejects a replayed nullifier (double-spend resistance)');
}

// ────────────────────────────────────────────────────────────────────────────
// Anchor window (§10 step 4 / §"Anchor window": W = 144)
// ────────────────────────────────────────────────────────────────────────────
{
  const nf = rand32();
  const env = buildBtcSpendEnvelope({ asset: ASSET, nullifiers: [nf], outKind: BTC_POOL_OUT_EXIT, exitVout: 0, exitValue: 1n, destSpkHash: rand32(), hAnchor: 1000, proof: '0x' });
  const parsed = parseBtcSpendEnvelope(env);
  const ctx = { txOutputs: [{ valueSats: 1n, scriptPubKeyHash: parsed.destSpkHash }] };
  const alwaysAccept = () => true;

  const state = makeBtcShieldedPoolState();
  commitBtcPoolBlockRoot(state, 1000 - BTC_POOL_ANCHOR_WINDOW); // exactly at the edge — retained
  const atEdge = await acceptBtcSpendEnvelope(state, parsed, { chainCtx: ctx, verifyProof: alwaysAccept });
  assert.equal(atEdge.accepted, true, 'h_anchor exactly W blocks behind the only retained root is still accepted');
  ok('acceptBtcSpendEnvelope accepts an h_anchor at the edge of the retained window');

  const state2 = makeBtcShieldedPoolState();
  commitBtcPoolBlockRoot(state2, 1000 - BTC_POOL_ANCHOR_WINDOW - 1); // one block too old
  const tooOld = await acceptBtcSpendEnvelope(state2, parsed, { chainCtx: ctx, verifyProof: alwaysAccept });
  assert.equal(tooOld.accepted, false, 'h_anchor outside the retained window is rejected');
  ok('acceptBtcSpendEnvelope rejects an h_anchor outside the retained anchor window');

  const state3 = makeBtcShieldedPoolState(); // no roots retained at all
  const noRoot = await acceptBtcSpendEnvelope(state3, parsed, { chainCtx: ctx, verifyProof: alwaysAccept });
  assert.equal(noRoot.accepted, false, 'h_anchor with no retained root at all is rejected');
  ok('acceptBtcSpendEnvelope rejects when no root is retained for h_anchor');
}

// ────────────────────────────────────────────────────────────────────────────
// Proof-verification stub fails closed (design §4/§12 step 2 — no guest/verifying key yet)
// ────────────────────────────────────────────────────────────────────────────
{
  assert.equal(await verifyBtcPoolSpendProof({ anything: true }, '0x' + 'ff'.repeat(256)), false, 'the stub verifier never returns true');
  ok('verifyBtcPoolSpendProof stub always fails closed');

  const nf = rand32();
  const env = buildBtcSpendEnvelope({ asset: ASSET, nullifiers: [nf], outKind: BTC_POOL_OUT_EXIT, exitVout: 0, exitValue: 1n, destSpkHash: rand32(), hAnchor: 5, proof: '0x' + 'ff'.repeat(256) });
  const parsed = parseBtcSpendEnvelope(env);
  const state = makeBtcShieldedPoolState();
  commitBtcPoolBlockRoot(state, 5);
  const ctx = { txOutputs: [{ valueSats: 1n, scriptPubKeyHash: parsed.destSpkHash }] };
  // No `verifyProof` override — uses the real (stub) default, which must reject.
  const res = await acceptBtcSpendEnvelope(state, parsed, { chainCtx: ctx });
  assert.equal(res.accepted, false, 'without a real verifying key, acceptBtcSpendEnvelope rejects by default (fail closed, not fail open)');
  assert.equal(state.nullifierSet.size, 0, 'a proof-rejected envelope mutates nothing');
  ok('acceptBtcSpendEnvelope fails closed end-to-end when no real proof verifier is wired in');
}

// ────────────────────────────────────────────────────────────────────────────
// Dapp-side: stealth spend-key derivation round-trips (sender derives, recipient recovers the same key)
// ────────────────────────────────────────────────────────────────────────────
{
  const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256: (b) => keccak_256(b) /* placeholder DI, unused by the paths under test */ });
  const recipientPriv = BigInt('0x' + '05'.repeat(32)) % secp.CURVE.n;
  const recipientPub = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(recipientPriv).toRawBytes(true)).toString('hex');
  const ephemeralPriv = '0x' + '06'.repeat(32);

  const { pkEph, spendKey } = pool.deriveBtcPoolSpendKey({ recipientSpendPub: recipientPub, ephemeralPriv });
  const recovered = pool.recoverBtcPoolSpendSecret({ recipientSpendPriv: '0x' + recipientPriv.toString(16).padStart(64, '0'), pkEph });
  assert.equal(recovered.spendKey.toLowerCase(), spendKey.toLowerCase(), 'recipient recovers the exact spend_key the sender derived');

  // The recovered sk_note must actually be the discrete log of spend_key (even-y canonical, per §2).
  const skG = secp.ProjectivePoint.BASE.multiply(BigInt(recovered.skNote));
  const skGxOnlyHex = '0x' + Buffer.from(skG.toRawBytes(true).slice(1)).toString('hex');
  assert.equal(skGxOnlyHex.toLowerCase(), spendKey.toLowerCase(), 'recovered sk_note·G x-coordinate matches the published spend_key');
  assert.equal(skG.toRawBytes(true)[0], 0x02, 'the derived spend_key point is even-y canonical (security doc A5 addendum)');
  ok('deriveBtcPoolSpendKey / recoverBtcPoolSpendSecret round-trip to the same, even-y-canonical spend_key');

  // A different recipient's key must NOT recover the same spend_key (soundness half of §6/G7).
  const otherPriv = '0x' + '99'.repeat(32);
  const wrongRecover = pool.recoverBtcPoolSpendSecret({ recipientSpendPriv: otherPriv, pkEph });
  assert.notEqual(wrongRecover.spendKey.toLowerCase(), spendKey.toLowerCase(), 'a different recipient key does not recover this note\'s spend_key');
  ok('recoverBtcPoolSpendSecret does not misattribute a note to the wrong recipient key');
}

// ────────────────────────────────────────────────────────────────────────────
// Dapp-side: ct_note AEAD seal/open round-trips, and scanBtcPoolNotes finds only the right note
// ────────────────────────────────────────────────────────────────────────────
{
  const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256: (b) => keccak_256(b) });
  const recipientPriv = BigInt('0x' + '11'.repeat(32)) % secp.CURVE.n;
  const recipientPub = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(recipientPriv).toRawBytes(true)).toString('hex');
  const ephemeralPriv = '0x' + '12'.repeat(32);
  // `deriveBtcPoolSpendKey` may retry with a bumped ephemeral secret to land on an even-y spend_key (see
  // its own comment) — use the ACTUAL ephemeral it settled on (`ephemeralPrivUsed`), not the caller's
  // original seed, when independently recomputing the shared secret below (the same thing a real sender
  // must do: derive pk_eph and the AEAD key from the same, possibly-bumped, ephemeral).
  const { pkEph, spendKey, ephemeralPrivUsed } = pool.deriveBtcPoolSpendKey({ recipientSpendPub: recipientPub, ephemeralPriv });

  const value = 42_000n, blinding = '0x' + '13'.repeat(32);
  const shared = secp.ProjectivePoint.fromHex(recipientPub.replace(/^0x/, '')).multiply(BigInt(ephemeralPrivUsed));
  const ctNote = pool.sealCtNote({ sharedPt: shared, value, blinding });
  const asset = ASSET;
  const cx = rand32(), cy = rand32();
  const leaf = pool.btcPoolNoteLeaf(asset, cx, cy, spendKey);

  const found = pool.scanBtcPoolNotes({
    envelopes: [{ asset, cx, cy, pkEph, spendKey, ctNote, leaf }],
    recipientSpendPriv: '0x' + recipientPriv.toString(16).padStart(64, '0'),
  });
  assert.equal(found.length, 1, 'scanBtcPoolNotes finds exactly the one note addressed to the recipient');
  assert.equal(found[0].value, value, 'recovered value matches what was sealed');
  assert.equal(found[0].blinding.toLowerCase(), blinding.toLowerCase(), 'recovered blinding matches what was sealed');
  ok('scanBtcPoolNotes recovers a note addressed to the recipient with the correct opening');

  const notFound = pool.scanBtcPoolNotes({
    envelopes: [{ asset, cx, cy, pkEph, spendKey, ctNote, leaf }],
    recipientSpendPriv: '0x' + '77'.repeat(32),
  });
  assert.equal(notFound.length, 0, 'a different recipient key finds nothing');
  ok('scanBtcPoolNotes finds nothing for a note not addressed to the scanning key');

  const tamperedLeafFound = pool.scanBtcPoolNotes({
    envelopes: [{ asset, cx, cy, pkEph, spendKey, ctNote, leaf: rand32() /* wrong leaf */ }],
    recipientSpendPriv: '0x' + recipientPriv.toString(16).padStart(64, '0'),
  });
  assert.equal(tamperedLeafFound.length, 0, 'a note whose published leaf does not match the re-derived leaf is rejected, not silently trusted');
  ok('scanBtcPoolNotes rejects a note whose leaf does not re-derive (tamper detection)');
}

console.log(`btc-shielded-pool: all ${n} checks passed`);
