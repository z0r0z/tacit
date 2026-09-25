// One-transaction pool joins and exits (dapp/btc-pool-zap.js): buy-and-shield carriers against the sale's
// SIGHASH_SINGLE|ANYONECANPAY signature and the indexer's shield acceptance; exit-to-sats bodies against the
// maker's validator, the indexer's want rules and seed recovery.
//   node tests/btc-pool-zap.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { secp, sha256, keccak_256, hmac, concatBytes, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { makeBtcPoolZap, makeNoteResolver } from '../dapp/btc-pool-zap.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import * as W from '../worker/src/btc-shielded-pool.js';
import { parseTx, decodeEnvelopeScript } from '../worker-relay/src/lib/btc-pool-chain.js';
import { tapScriptSighash } from '../worker-relay/src/lib/btc-pool-relayer.js';

if (!secp.etc.hmacSha256Sync) secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, concatBytes(...m));

const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
const zap = makeBtcPoolZap({ secp, sha256, keccak256: keccak_256 });
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const strip = (h) => String(h).replace(/^0x/, '');
const ASSET = '0x' + 'ab'.repeat(32);
const p2tr = (tag) => concatBytes(Uint8Array.of(0x51, 0x20), sha256(new TextEncoder().encode(tag)));

const tests = [];
const test = (n, f) => tests.push([n, f]);

// ── generic BIP-143 (any sighash type), independent of the module under test ──
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
const vs = (b) => concatBytes(Uint8Array.of(b.length), b);
const h256 = (b) => sha256(sha256(b));
function bip143(tx, idx, pkh, value, ht) {
  const acp = ht & 0x80, base = ht & 0x1f;
  const zero = new Uint8Array(32);
  const prevouts = acp ? zero : h256(concatBytes(...tx.inputs.flatMap((i) => [hexToBytes(i.txid).reverse(), u32(i.vout)])));
  const seqs = acp || base !== 1 ? zero : h256(concatBytes(...tx.inputs.map((i) => u32(i.sequence))));
  const outs = base === 3 ? (idx < tx.outputs.length ? h256(concatBytes(u64(tx.outputs[idx].value), vs(tx.outputs[idx].script))) : zero)
    : h256(concatBytes(...tx.outputs.flatMap((o) => [u64(o.value), vs(o.script)])));
  const inp = tx.inputs[idx];
  return h256(concatBytes(u32(tx.version), prevouts, seqs, hexToBytes(inp.txid).reverse(), u32(inp.vout),
    vs(concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), pkh, Uint8Array.of(0x88, 0xac))), u64(value), u32(inp.sequence), outs, u32(tx.locktime), u32(ht)));
}
const toTxObj = (t) => ({
  version: 2, locktime: 0,
  inputs: t.vin.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 0xfffffffd })),
  outputs: t.vout.map((o) => ({ value: Number(o.value), script: o.scriptPubKey })),
});
// DER from (r, s): minimal big-endian integers with a sign byte where the top bit is set.
const der = ({ r, s }) => {
  const int = (x) => { let b = hexToBytes(x.toString(16).padStart(64, '0')); let i = 0; while (i < 31 && b[i] === 0 && !(b[i + 1] & 0x80)) i++; b = b.slice(i); return b[0] & 0x80 ? concatBytes(Uint8Array.of(0), b) : b; };
  const R = int(r), S = int(s);
  return concatBytes(Uint8Array.of(0x30, 4 + R.length + S.length, 0x02, R.length), R, Uint8Array.of(0x02, S.length), S);
};
const compressXY = ({ cx, cy }) => concatBytes(Uint8Array.of(parseInt(strip(cy).slice(-2), 16) & 1 ? 3 : 2), hexToBytes(strip(cx)));

// ── buy and shield fixtures ──
function saleFixture({ amount = 5_000n, price = 12_000, lotValue = 546 } = {}) {
  const sellerPriv = rnd(32); sellerPriv[0] = 1;
  const sellerPub = secp.getPublicKey(sellerPriv, true);
  const { prims: sp } = makeBtcWallet({ priv: sellerPriv, hrp: 'tb' });
  const payout = sp.p2wpkhScript(sellerPub);
  const blinding = BigInt('0x' + bytesToHex(rnd(32))) % secp.CURVE.n;
  const C = bp.commitXY(amount, blinding);
  const outpoint = { txid: bytesToHex(rnd(32)), vout: 2, value: lotValue };
  const pkh = sp.p2wpkhScript(sellerPub).slice(2);
  // The seller signs the skeleton: vin[1] = lot, vout[1] = payout, SIGHASH_SINGLE|ANYONECANPAY.
  const skeleton = { version: 2, locktime: 0, inputs: [{ txid: '00'.repeat(32), vout: 0, sequence: 0xfffffffd }, { txid: outpoint.txid, vout: outpoint.vout, sequence: 0xfffffffd }], outputs: [{ value: 546, script: new Uint8Array(22) }, { value: price, script: payout }] };
  const digest = bip143(skeleton, 1, pkh, lotValue, 0x83);
  assert.deepEqual(zap.singleAcpSighash({ outpoint, value: lotValue, pkh, payout: { value: price, script: payout } }), digest);
  const sig = concatBytes(der(secp.sign(digest, sellerPriv, { lowS: true })), Uint8Array.of(0x83));
  const sale = {
    asset_id: strip(ASSET), sale_id: bytesToHex(rnd(16)), seller_pubkey: bytesToHex(sellerPub), seller_payout_script: bytesToHex(payout),
    asset_outpoint: outpoint, asset_opening: { amount: amount.toString(), blinding: blinding.toString(16).padStart(64, '0') },
    min_price_sats: price, expiry: Math.floor(Date.now() / 1000) + 3600, seller_asset_spend_sig: bytesToHex(sig),
  };
  return { sale, sellerPub, payout, pkh, C, amount, blinding, outpoint };
}
function buyer(fx, { lot = null } = {}) {
  const priv = rnd(32); priv[0] = 2;
  const { prims } = makeBtcWallet({ priv, hrp: 'tb' });
  const commitment = compressXY(fx.C);
  const tacit = {
    ...prims, wallet: prims.wallet,
    resolveNote: async (txid, vout) => (lot !== null ? lot : txid === fx.outpoint.txid && vout === fx.outpoint.vout ? { assetIdHex: strip(ASSET), commitment } : null),
  };
  return { tacit, prims, spk: prims.p2wpkhScript(prims.wallet.pub), utxos: [{ txid: bytesToHex(rnd(32)), vout: 0, value: 100_000 }] };
}

test('buy and shield: one carrier, the lot at vin[1] under the seller\'s signature, payout at vout[1], shield accepted', async () => {
  const fx = saleFixture();
  const b = buyer(fx);
  const alice = bp.walletFromSeed(rnd(32), 'signet');
  const r = await zap.buyAndShield({ tacit: b.tacit, pool: bp, sale: fx.sale, wallet: { utxos: b.utxos, feeRate: 2 }, recipientAddress: alice.addressString });
  const commit = parseTx(hexToBytes(r.commitHex)).tx;
  const carrier = parseTx(hexToBytes(r.carrierHex)).tx;
  assert.equal(carrier.txid, r.carrierTxid);
  assert.equal(commit.txid, r.commitTxid);
  assert.deepEqual([carrier.vin[0].txid, carrier.vin[0].vout], [commit.txid, 0]);
  assert.deepEqual([carrier.vin[1].txid, carrier.vin[1].vout], [fx.outpoint.txid, fx.outpoint.vout]);
  assert.equal(carrier.vin.length, 2);
  assert.deepEqual(carrier.vout.map((o) => [bytesToHex(o.scriptPubKey), o.value]), [[bytesToHex(b.spk), carrier.vout[0].value], [bytesToHex(fx.payout), 12_000n]]);
  assert.ok(carrier.vout[0].value >= 546n);

  // The seller's signature verifies over the real carrier at input 1 (SIGHASH_SINGLE|ANYONECANPAY).
  const tx = toTxObj(carrier);
  const [der, pub] = carrier.vin[1].witness;
  assert.deepEqual(pub, fx.sellerPub);
  assert.equal(der[der.length - 1], 0x83);
  assert.ok(secp.verify(zap.derToCompact(der.slice(0, -1)), bip143(tx, 1, fx.pkh, 546, 0x83), fx.sellerPub, { lowS: true }));
  // The buyer's script-path signature over the whole carrier.
  const env = decodeEnvelopeScript(carrier.vin[0].witness[1]);
  const prevouts = [{ value: Number(commit.vout[0].value), script: commit.vout[0].scriptPubKey }, { value: 546, script: b.prims.p2wpkhScript(fx.sellerPub) }];
  assert.ok(bp.schnorrVerify(carrier.vin[0].witness[0], tapScriptSighash(tx, 0, prevouts, b.prims.tapLeafHash(carrier.vin[0].witness[1])), b.prims.wallet.xonly()));
  // Fees: the envelope output funds the price and the carrier fee; the buyer's change returns at vout[0].
  const carrierFee = Number(commit.vout[0].value) + 546 - Number(carrier.vout[0].value) - 12_000;
  assert.equal(carrierFee, r.revealFee);
  const raw = hexToBytes(r.carrierHex);
  let wit = 2; for (const i of carrier.vin) wit += 1 + i.witness.reduce((x, w) => x + (w.length < 0xfd ? 1 : 3) + w.length, 0);
  const vsize = Math.ceil(((raw.length - wit) * 4 + wit) / 4);
  assert.ok(carrierFee >= vsize * 2 && carrierFee < vsize * 2 + 40, `carrier fee ${carrierFee} for ${vsize} vB`);

  // The indexer accepts the shield with the lot as its only input.
  assert.equal(env.opcode, 0x6c);
  const envs = W.carrierPoolEnvelopes([{ opcode: env.opcode, payload: env.payload }, null]);
  assert.deepEqual(envs.items.map((x) => x.vin), [0]);
  const st = new W.BtcPoolState();
  st.beginBlock(900);
  const res = await st.acceptShield(W.parseShield(env.payload), {
    txid: carrier.txid, inputs: carrier.vin,
    resolveInput: async (op, assetHex) => (op.txid === fx.outpoint.txid && op.vout === fx.outpoint.vout && assetHex === strip(ASSET) ? { cx: hexToBytes(strip(fx.C.cx)), cy: hexToBytes(strip(fx.C.cy)) } : null),
  });
  assert.ok(res.accepted, res.reason);
  const got = bp.scan(alice, [{ ...r.note, leafIndex: 0 }]);
  assert.equal(got.length, 1);
  assert.equal(got[0].value, 5_000n);
  assert.equal(bytesToHex(st.tree.leaf(0)), strip(r.note.leaf));
});

test('buy and shield: refuses a stale or forged sale before any sats move', async () => {
  const alice = bp.walletFromSeed(rnd(32), 'signet');
  const run = (fx, over = {}, b = buyer(fx)) => zap.buyAndShield({ tacit: b.tacit, pool: bp, sale: { ...fx.sale, ...over }, wallet: { utxos: b.utxos, feeRate: 2 }, recipientAddress: alice.addressString });
  const fx = saleFixture();
  await assert.rejects(run(fx, { asset_opening: { ...fx.sale.asset_opening, amount: '5001' } }), /opening does not match/);
  await assert.rejects(run(fx, { min_price_sats: 11_999 }), /seller signature does not verify/, 'a price the seller did not sign');
  await assert.rejects(run(fx, { seller_payout_script: bytesToHex(p2tr('thief')) }), /seller signature does not verify/);
  await assert.rejects(run(fx, { asset_outpoint: { ...fx.outpoint, value: 547 } }), /seller signature does not verify/);
  await assert.rejects(run(fx, { expiry: 1 }), /expired/);
  await assert.rejects(run(fx, { seller_asset_spend_sig: fx.sale.seller_asset_spend_sig.slice(0, -2) + '01' }), /SINGLE\|ANYONECANPAY/);
  await assert.rejects(run(fx, { asset_opening: { ...fx.sale.asset_opening, amount: 5000 + 0.5 } }), /decimal integer/);
  await assert.rejects(run(fx, {}, buyer(fx, { lot: false })), /not a valid Tacit note/);
  await assert.rejects(run(fx, {}, buyer(fx, { lot: { assetIdHex: 'cd'.repeat(32), commitment: compressXY(fx.C) } })), /another asset/);
  const poor = buyer(fx); poor.utxos = [{ txid: 'aa'.repeat(32), vout: 0, value: 5_000 }];
  await assert.rejects(run(fx, {}, poor), /need \d+ sats/);
});

// ── exit to sats ──
const USER_SEED = rnd(32);
function poolWithNotes(values, wallet) {
  const st = new W.BtcPoolState();
  const notes = values.map((v) => bp.createNote(wallet.addressString, ASSET, v));
  st.beginBlock(1000);
  for (const n of notes) st._appendLeaf({ leaf: hexToBytes(strip(n.leaf)) });
  st.endBlock();
  for (let h = 1001; h <= 1006; h++) { st.beginBlock(h); st.endBlock(); }
  const size = notes.length;
  const scanned = bp.scan(wallet, notes.map((n, i) => ({ ...n, leafIndex: i }))).map((x) => ({ ...x, path: st.tree.rootAndPathAt(x.leafIndex, size).path.map((p) => '0x' + bytesToHex(p)) }));
  return { st, notes, scanned, root: st.roots.get(1000) };
}
const MAKER_SPK = p2tr('maker');
const MAKER = { spk: MAKER_SPK, sats: 50_000, vout: 1 };
const AMOUNT = 55_000n;
const toOuts = (outs) => outs.map((o) => ({ value: BigInt(o.value), scriptPubKey: o.script }));

test('exit to sats: signed exit + want; the maker validates, builds the carrier, and the indexer accepts it; the user recovers it from the seed', async () => {
  const user = bp.walletFromSeed(USER_SEED, 'signet');
  const { st, scanned, root, notes } = poolWithNotes([60_000n, 7n], user);
  const used = new Set();
  const r = zap.exitToSats({ pool: bp, wallet: user, notes: scanned, amount: AMOUNT, maker: MAKER, hAnchor: 1000, root, usedScripts: used });
  const body = r.spend.body;
  const parsed = bp.parseSpend(body);
  assert.equal(parsed.nullifiers.length, 2, 'the second note joins as the padding input');
  assert.deepEqual([parsed.exit.exitVout, parsed.exit.destSpkHash], [0, '0x' + bytesToHex(sha256(MAKER_SPK))]);
  assert.deepEqual(parsed.want, { vout: 1, value: 50_000n, spkHash: r.payout.destSpkHash });
  assert.equal(r.payout.scriptPubKey, bp.deriveExitKey(user, 0).scriptPubKey, 'a fresh key from the seed');
  assert.ok(used.has(r.payout.destSpkHash));
  assert.equal(zap.exitToSats({ pool: bp, wallet: user, notes: scanned, amount: AMOUNT, maker: MAKER, hAnchor: 1000, usedScripts: used }).payout.counter, 1, 'the next exit takes the next key');
  assert.equal(parsed.outputs.length, 3);
  const own = bp.scan(user, parsed.outputs.map((o, i) => ({ ...o, leafIndex: 10 + i })));
  assert.deepEqual(own.map((x) => x.value).sort(), [0n, 0n, 5_007n]);
  assert.ok(own.every((x) => x.internal), 'change and padding to the internal address');
  assert.equal(r.offer.exitOpening.value, AMOUNT);

  const proof = rnd(64);
  const payload = bp.assembleSpendEnvelope(body, proof);
  const pvOk = async ({ proof: p, publicValues }) => bytesToHex(p) === bytesToHex(proof) && bytesToHex(publicValues) === bytesToHex(W.spendPublicValues(root, body));
  const v = await zap.validateExitToSats({ pool: bp, payload, offer: r.offer, maker: MAKER, amount: AMOUNT, asset: ASSET, root, verify: pvOk });
  assert.deepEqual([v.exitVout, v.wantVout, v.wantValue], [0, 1, 50_000n]);

  const outs = zap.makerCarrierOutputs({ ...v, makerSpk: MAKER_SPK });
  assert.deepEqual(outs.map((o) => [bytesToHex(o.script), o.value]), [[bytesToHex(MAKER_SPK), 330], [strip(r.payout.scriptPubKey), 50_000]]);
  const makerCoin = { txid: 'fe'.repeat(32), vout: 3 };
  const ctx = (txid, outputs) => ({ txid, inputs: [{ txid: 'e0'.repeat(32), vout: 0 }, makerCoin], outputs: toOuts(outputs), vin0TacitOp: false, verifyProof: pvOk });
  const s = W.parseSpend(payload);
  st.beginBlock(1007);
  // A carrier that underpays, omits or redirects the want is rejected and changes nothing.
  const under = outs.map((o) => ({ ...o })); under[1].value = 49_999;
  assert.match((await st.acceptSpend(s, ctx('c1'.repeat(32), under))).reason, /pays less/);
  assert.match((await st.acceptSpend(s, ctx('c2'.repeat(32), outs.slice(0, 1)))).reason, /want vout is not an output/);
  const redirected = outs.map((o) => ({ ...o })); redirected[1].script = MAKER_SPK;
  assert.match((await st.acceptSpend(s, ctx('c3'.repeat(32), redirected))).reason, /spk_hash/);
  const swapped = [outs[1], outs[0]];
  assert.match((await st.acceptSpend(s, ctx('c4'.repeat(32), swapped))).reason, /dest_spk_hash/);
  assert.equal(st.nullifiers.size, 0);
  assert.equal(st.exits.size, 0);
  // Overpaying the want is fine.
  const over = outs.map((o) => ({ ...o })); over[1].value = 50_001;
  const ok = await st.acceptSpend(s, ctx('c5'.repeat(32), over));
  assert.ok(ok.accepted, ok.reason);
  assert.ok(st.exits.has(`${'c5'.repeat(32)}:0`));
  assert.deepEqual(ok.want, { txid: 'c5'.repeat(32), vout: 1, value: 50_000n });
  assert.equal(ok.leaves.length, 3);
  st.endBlock();

  // Seed recovery of the exit opening, with the want after the exit in the body.
  const fresh = bp.walletFromSeed(USER_SEED, 'signet');
  const chainNotes = notes.map(({ value, blinding, ...pub }, i) => ({ ...pub, leafIndex: i }));
  const rec = bp.recoverExit(fresh, payload, bp.scan(fresh, chainNotes));
  assert.deepEqual([rec.value, rec.blinding, rec.exitVout], [AMOUNT, r.offer.exitOpening.blinding, 0]);

  // The committed guest accepts the wallet-built witness when the host binary is present.
  const host = new URL('../contracts/sp1/confidential/btc-pool-host/target/release/btc-pool-prove', import.meta.url).pathname;
  if (existsSync(host)) {
    const out = JSON.parse(execFileSync(host, { input: JSON.stringify(r.spend.witness), env: { PATH: process.env.PATH, PROVE_MODE: 'execute' }, encoding: 'utf8', maxBuffer: 1 << 24 }).trim().split('\n').pop());
    assert.equal(out.public_values, '0x' + bytesToHex(W.spendPublicValues(root, body)));
    console.log(`    (guest executed the want-carrying spend: ${out.cycles} cycles)`);
  } else console.log('    (skipped guest execution: btc-pool-host not built)');
});

test('exit to sats: the maker refuses offers that do not match its terms', async () => {
  const user = bp.walletFromSeed(rnd(32), 'signet');
  const { scanned, root } = poolWithNotes([60_000n], user);
  const r = zap.exitToSats({ pool: bp, wallet: user, notes: scanned, amount: AMOUNT, maker: MAKER, hAnchor: 1000, root, pad: false });
  assert.equal(bp.parseSpend(r.spend.body).outputs.length, 1, 'change only without padding');
  const payload = bp.assembleSpendEnvelope(r.spend.body, rnd(8));
  const check = (over, re) => assert.rejects(zap.validateExitToSats({ pool: bp, payload, offer: r.offer, maker: MAKER, amount: AMOUNT, asset: ASSET, ...over }), re);
  await check({ amount: AMOUNT + 1n }, /agreed amount/);
  await check({ maker: { ...MAKER, sats: 49_999 } }, /more than the agreed sats/);
  await check({ maker: { ...MAKER, spk: p2tr('other-maker') } }, /maker script/);
  await check({ maker: { ...MAKER, vout: 2 } }, /want is not at the agreed output/);
  await check({ maker: { ...MAKER, exitVout: 2 } }, /exit is not at the agreed output/);
  await check({ maker: { ...MAKER, bind: { txid: 'ab'.repeat(32), vout: 1 } } }, /bind/);
  await check({ asset: '0x' + 'cd'.repeat(32) }, /another asset/);
  await check({ offer: { ...r.offer, payoutScriptPubKey: bytesToHex(p2tr('not-the-user')) } }, /payout script does not match/);
  await check({ offer: { ...r.offer, exitOpening: { ...r.offer.exitOpening, blinding: '0x' + '11'.repeat(32) } } }, /does not open/);
  await check({ root, verify: async () => false }, /proof does not verify/);
  await check({ payload: r.spend.body, root, verify: async () => true }, /carries no proof/);
  assert.ok(await zap.validateExitToSats({ pool: bp, payload: r.spend.body, offer: r.offer, maker: MAKER, amount: AMOUNT }), 'a bare body validates without a proof check');

  // Terms the user refuses to sign.
  const sign = (maker, extra = {}) => () => zap.exitToSats({ pool: bp, wallet: user, notes: scanned, amount: AMOUNT, maker, hAnchor: 1000, ...extra });
  assert.throws(sign({ ...MAKER, vout: 0, exitVout: 0 }), /distinct outputs/);
  assert.throws(sign({ ...MAKER, sats: 329 }), /dust floor/);
  assert.throws(sign({ ...MAKER, sats: '50000' }), /maker sats/);
  assert.throws(sign({ ...MAKER, spk: '6a' }), /standard/);
  assert.throws(sign(MAKER, { amount: 60_001n }), /cannot cover/);
  assert.throws(sign(MAKER, { amount: 5.5 }), /amount/);

  // A maker bind is signed into the body and binds the carrier.
  const bound = zap.exitToSats({ pool: bp, wallet: user, notes: scanned, amount: AMOUNT, maker: { ...MAKER, bind: { txid: 'ab'.repeat(32), vout: 7 } }, hAnchor: 1000 });
  const bs = W.parseSpend(bp.assembleSpendEnvelope(bound.spend.body, rnd(8)));
  assert.deepEqual(bs.bind, { txid: 'ab'.repeat(32), vout: 7 });
  const st = poolWithNotes([1n], user).st;
  st.beginBlock(1007);
  const outs = toOuts(zap.makerCarrierOutputs({ exitVout: 0, wantVout: 1, wantValue: 50_000n, payoutScriptPubKey: bound.payout.scriptPubKey, makerSpk: MAKER_SPK }));
  const base = { txid: 'd1'.repeat(32), outputs: outs, vin0TacitOp: false, verifyProof: async () => true };
  assert.match((await st.acceptSpend(bs, { ...base, inputs: [{ txid: 'e0'.repeat(32), vout: 0 }] })).reason, /bound outpoint/);
  assert.ok((await st.acceptSpend(bs, { ...base, inputs: [{ txid: 'e0'.repeat(32), vout: 0 }, { txid: 'ab'.repeat(32), vout: 7 }] })).accepted);
});

test('note resolver: a lot is a note only when the transparent validator accepts it', async () => {
  const C = new Uint8Array(33).fill(2);
  const txs = { ['aa'.repeat(32)]: { txid: 'aa'.repeat(32), env: 'good' }, ['bb'.repeat(32)]: { txid: 'bb'.repeat(32), env: 'bad' } };
  const resolve = makeNoteResolver({
    fetchTx: async (t) => txs[t] || null,
    validateOutpoint: async (t, v) => txs[t]?.env === 'good' && v === 0,
    txOutputEnvelope: (tx) => ({ opcode: 0x23, tag: tx.env }),
    getParentEnvelopeData: async (env, v) => (env.tag === 'good' && v === 0 ? { assetIdHex: 'ab'.repeat(32), commitment: C } : null),
  });
  assert.deepEqual(await resolve('aa'.repeat(32), 0), { assetIdHex: 'ab'.repeat(32), commitment: C });
  assert.equal(await resolve('aa'.repeat(32), 1), null);
  assert.equal(await resolve('bb'.repeat(32), 0), null);
});

test('maker carrier outputs: filler below the higher index, dust floors per script', () => {
  const payout = p2tr('u');
  const outs = zap.makerCarrierOutputs({ exitVout: 2, wantVout: 0, wantValue: 1234n, payoutScriptPubKey: payout, makerSpk: MAKER_SPK, filler: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20)) });
  assert.deepEqual(outs.map((o) => o.value), [1234, 294, 330]);
  assert.equal(zap.dustFor(Uint8Array.of(0x6a)), null);
});

let passed = 0;
for (const [n, f] of tests) {
  try { await f(); passed++; console.log('  ok -', n); } catch (e) { console.error('  FAIL -', n); console.error(e); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} passed`);
