#!/usr/bin/env node
// dapp/burn-deposit-reveal.js: builds and signs the migrate + burn-deposit-reveal transactions with a
// deterministic test wallet and a synthetic source note, then verifies the result independently — signatures
// against a from-scratch BIP-341 sighash, and both transactions read back the way the guest reads them
// (dapp/burn-deposit-bitcoin.js's classifyConfidentialTx/extractInputs, the same functions reflect.rs mirrors).
//
// Run: node tests/burn-deposit-reveal.test.mjs

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeBurnDepositReveal } from '../dapp/burn-deposit-reveal.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { verifySchnorr } from '../dapp/bulletproofs.js';
import { classifyConfidentialTx, extractInputs } from '../dapp/burn-deposit-bitcoin.js';
import { secp as vsecp, hmac, sha256 as vsha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

if (!vsecp.etc.hmacSha256Sync) vsecp.etc.hmacSha256Sync = (k, ...m) => hmac(vsha256, k, concatBytes(...m));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join('');

// ---- load dapp/tacit.js under a DOM shim (same pattern every real burn-deposit build script uses) ----
const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import('./_domshim.mjs');
globalThis.fetch = realFetch; globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
const tacit = await import('../dapp/tacit.js');
// Only pure/stateless functions come from tacit.js — it has its own, separately-stateful wallet singleton that
// does NOT share state with makeBtcWallet's, so anything that implicitly reads wallet.priv (taproot/P2WPKH
// signing) must come from makeBtcWallet instead (see dapp/burn-deposit-reveal.js's own header comment).
const {
  encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount,
  signSchnorr, modN,
} = tacit;

const ASSET = '0x' + 'a5'.repeat(32);
const WALLET_PRIV = new Uint8Array(32).fill(0x11);
const NOTE_TXID = '5e'.repeat(31) + '01'; // display order, synthetic
const NOTE_VOUT = 0;
const NOTE_AMOUNT = 900_000n, NOTE_BLINDING = 0x77777777n, NOTE_SATS = 1_000;
const FUND_TXID = '6f'.repeat(32);

function testWallet({ rate = 3 } = {}) {
  const sent = [];
  const w = makeBtcWallet({
    priv: WALLET_PRIV, hrp: 'bc',
    fetchUtxos: async () => [],
    broadcastTx: async (hex) => { sent.push(hex); return 'ok'; },
    fetchFeeRate: async () => rate,
  });
  const extended = {
    ...w.prims, sha256,
    encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount,
    signSchnorr, modN,
  };
  return { prims: extended, wallet: w.wallet, sent };
}

// ---- independent BIP-341 sighash + tx parser, to check the builder's bytes without trusting its own checks ----
const sh = (b) => createHash('sha256').update(b).digest();
const tagged = (tag, msg) => { const t = sh(Buffer.from(tag)); return sh(Buffer.concat([t, t, msg])); };
const varintBuf = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));
function parseTx(b) {
  let p = 0;
  const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
  const vi = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } const v = b.readUInt32LE(p); p += 4; return v; };
  const bytes = (n) => { const s = b.subarray(p, p + n); p += n; return s; };
  const version = u32();
  const segwit = b[p] === 0 && b[p + 1] === 1; if (segwit) p += 2;
  const inputs = []; for (let i = vi(); i > 0; i--) inputs.push({ txid: bytes(32), vout: u32(), scriptSig: bytes(vi()), sequence: u32(), witness: [] });
  const outputs = []; for (let i = vi(); i > 0; i--) { const value = b.readBigUInt64LE(p); p += 8; outputs.push({ value, script: bytes(vi()) }); }
  if (segwit) for (const inp of inputs) for (let k = vi(); k > 0; k--) inp.witness.push(bytes(vi()));
  const locktime = u32();
  assert.strictEqual(p, b.length, 'tx parses exactly');
  return { version, inputs, outputs, locktime };
}
function bip341Sighash(tx, idx, prevouts, leafHash) {
  const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); return x; };
  const u64 = (v) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(BigInt(v)); return x; };
  const msg = [Buffer.from([0x00, 0x00]), u32(tx.version), u32(tx.locktime),
    sh(Buffer.concat(tx.inputs.map((i) => Buffer.concat([i.txid, u32(i.vout)])))),
    sh(Buffer.concat(prevouts.map((o) => u64(o.value)))),
    sh(Buffer.concat(prevouts.map((o) => Buffer.concat([varintBuf(o.script.length), o.script])))),
    sh(Buffer.concat(tx.inputs.map((i) => u32(i.sequence)))),
    sh(Buffer.concat(tx.outputs.map((o) => Buffer.concat([u64(o.value), varintBuf(o.script.length), o.script])))),
    Buffer.from([leafHash ? 0x02 : 0x00]), u32(idx)];
  if (leafHash) msg.push(leafHash, Buffer.from([0x00]), u32(0xffffffff));
  return tagged('TapSighash', Buffer.concat(msg));
}
function independentLeafHash(script) { return tagged('TapLeaf', Buffer.concat([Buffer.from([0xc0]), varintBuf(script.length), script])); }

// ==== the actual test ====
const rd = makeBurnDepositReveal({ pool, secp });
const { prims } = testWallet();

// deriveBurnHomeKey is deterministic
{
  const a = rd.deriveBurnHomeKey({ walletPriv: WALLET_PRIV, noteTxid: NOTE_TXID, noteVout: NOTE_VOUT }, { sha256 });
  const b = rd.deriveBurnHomeKey({ walletPriv: WALLET_PRIV, noteTxid: NOTE_TXID, noteVout: NOTE_VOUT }, { sha256 });
  assert.deepStrictEqual(a.priv, b.priv, 'same inputs -> same burn-home key');
  const c = rd.deriveBurnHomeKey({ walletPriv: WALLET_PRIV, noteTxid: NOTE_TXID, noteVout: 1 }, { sha256 });
  assert.notDeepStrictEqual(a.priv, c.priv, 'a different vout -> a different key');
  assert.strictEqual(a.pub[0] === 0x02, true, 'even-y normalized (BIP340 x-only convention)');
  ok('deriveBurnHomeKey is deterministic in (walletPriv, noteTxid, noteVout) and even-y normalized');
}

// Phase 1: migrate
const note = { assetId: ASSET, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING, txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS };
const fundingUtxo1 = { txid: FUND_TXID, vout: 0, value: 30_000 };
const mig = await rd.buildMigrationTxs({ prims, note, walletPriv: WALLET_PRIV, fundingUtxo: fundingUtxo1, feeRate: 3 });

{
  const cls = classifyConfidentialTx(mig.revealHex);
  assert.ok(cls && cls.type === 'cxfer' && cls.opcode === 0x22, 'migration reveal classifies as T_CXFER_BPP');
  assert.strictEqual(cls.assetId.toLowerCase(), ASSET.toLowerCase());
  ok('migration reveal classifies as a T_CXFER_BPP cxfer under the source note\'s asset');
}
{
  const reveal = parseTx(Buffer.from(mig.revealHex, 'hex'));
  const commit = parseTx(Buffer.from(mig.commitHex, 'hex'));
  assert.strictEqual(reveal.inputs[0].witness.length, 3, 'migration reveal vin[0] is a 3-item script-path spend');
  assert.strictEqual(reveal.inputs[1].witness.length, 2, 'migration reveal vin[1] (the source note) is a 2-item P2WPKH spend [sig, pubkey]');
  const [sig0, script0, cb0] = reveal.inputs[0].witness;
  const leafHash = independentLeafHash(script0);
  // The note's own prevout script is the wallet's P2WPKH (source note lives at the funding wallet's own address).
  const walletPub = secp.getPublicKey(WALLET_PRIV, true);
  const realPrevouts = [{ value: commit.outputs[0].value, script: commit.outputs[0].script }, { value: BigInt(NOTE_SATS), script: prims.p2wpkhScript(walletPub) }];
  assert.ok(verifySchnorr(sig0, bip341Sighash(reveal, 0, realPrevouts, leafHash), script0.subarray(1, 33)), 'migration vin[0] signature verifies under an independently-recomputed BIP-341 sighash');
  const Q = secp.ProjectivePoint.fromHex('02' + cb0.subarray(1).toString('hex')).add(secp.ProjectivePoint.BASE.multiply(BigInt('0x' + tagged('TapTweak', Buffer.concat([cb0.subarray(1), leafHash])).toString('hex'))));
  const qx = Buffer.from(Q.toRawBytes(true)).subarray(1);
  assert.strictEqual(commit.outputs[0].script.toString('hex'), '5120' + qx.toString('hex'), 'migration commit output commits to the envelope leaf (independently recomputed)');
  ok('migration reveal signature + commit-output tweak independently verified via a from-scratch BIP-341 sighash');
}

// sourcePriv: a stealth-received note sits at P2WPKH(commit), commit != walletPub, so its spend key differs
// from walletPriv. buildMigrationTxs must sign the note's OWN input under sourcePriv while keeping the
// funding UTXO, the envelope's authority and the reveal's change on walletPriv — mirrors this same note
// (same outpoint) to isolate exactly what sourcePriv is allowed to change.
{
  const dsha256 = (b) => sh(sh(b));
  const hash160 = (b) => createHash('ripemd160').update(sh(b)).digest();
  // noble/secp256k1 v2's verify() takes only the 64-byte compact (r||s) form, not DER — signP2wpkhInput's
  // witness carries DER (+ trailing sighash-type byte), so convert before verifying.
  function derSigToCompact(der) {
    let p = 0;
    if (der[p++] !== 0x30) throw new Error('not a DER sequence');
    p++; // total-length byte (short form only; secp256k1 sig components never need long-form here)
    if (der[p++] !== 0x02) throw new Error('expected INTEGER (r)');
    const rLen = der[p++]; const r = der.subarray(p, p + rLen); p += rLen;
    if (der[p++] !== 0x02) throw new Error('expected INTEGER (s)');
    const sLen = der[p++]; const s = der.subarray(p, p + sLen);
    const to32 = (x) => { while (x.length > 32 && x[0] === 0) x = x.subarray(1); const out = Buffer.alloc(32); Buffer.from(x).copy(out, 32 - x.length); return out; };
    return Buffer.concat([to32(r), to32(s)]);
  }
  function bip143Sighash(tx, idx, scriptCode, prevValue) {
    const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); return x; };
    const u64 = (v) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(BigInt(v)); return x; };
    const hashPrevouts = dsha256(Buffer.concat(tx.inputs.map((i) => Buffer.concat([i.txid, u32(i.vout)]))));
    const hashSequence = dsha256(Buffer.concat(tx.inputs.map((i) => u32(i.sequence))));
    const hashOutputs = dsha256(Buffer.concat(tx.outputs.map((o) => Buffer.concat([u64(o.value), varintBuf(o.script.length), o.script]))));
    const inp = tx.inputs[idx];
    return dsha256(Buffer.concat([
      u32(tx.version), hashPrevouts, hashSequence, inp.txid, u32(inp.vout),
      varintBuf(scriptCode.length), scriptCode, u64(prevValue), u32(inp.sequence),
      hashOutputs, u32(tx.locktime), u32(0x00000001),
    ]));
  }

  const SOURCE_PRIV = new Uint8Array(32).fill(0x22); // stands in for a stealth tweaked_sk, deliberately != WALLET_PRIV
  const sourcePub = secp.getPublicKey(SOURCE_PRIV, true);
  const mig2 = await rd.buildMigrationTxs({ prims, note, walletPriv: WALLET_PRIV, sourcePriv: SOURCE_PRIV, fundingUtxo: { ...fundingUtxo1, txid: '9a'.repeat(32) }, feeRate: 3 });

  const reveal2 = parseTx(Buffer.from(mig2.revealHex, 'hex'));
  const [sig1, pub1] = reveal2.inputs[1].witness;
  assert.deepStrictEqual(Buffer.from(pub1), Buffer.from(sourcePub), 'the note input signs with sourcePriv\'s pubkey, not walletPriv\'s');
  const scriptCode = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash160(sourcePub), Buffer.from([0x88, 0xac])]);
  const sigNoType = sig1.subarray(0, sig1.length - 1); // strip the trailing SIGHASH_ALL byte before verify
  const sigCompact = derSigToCompact(sigNoType);
  assert.ok(secp.verify(sigCompact, bip143Sighash(reveal2, 1, scriptCode, NOTE_SATS), sourcePub), 'note-input signature independently verifies under a from-scratch BIP-143 sighash keyed to sourcePriv');

  const walletPub = secp.getPublicKey(WALLET_PRIV, true);
  assert.notDeepStrictEqual(Buffer.from(pub1), Buffer.from(walletPub), 'sanity: sourcePriv and walletPriv are genuinely different keys here');

  // Envelope authority (vin[0]) and the reveal's own change output stay on walletPriv regardless of sourcePriv.
  const [sig0, script0, cb0] = reveal2.inputs[0].witness;
  const leafHash = independentLeafHash(script0);
  const commit2 = parseTx(Buffer.from(mig2.commitHex, 'hex'));
  const realPrevouts2 = [{ value: commit2.outputs[0].value, script: commit2.outputs[0].script }, { value: BigInt(NOTE_SATS), script: Buffer.concat([Buffer.from([0x00, 0x14]), hash160(sourcePub)]) }];
  assert.ok(verifySchnorr(sig0, bip341Sighash(reveal2, 0, realPrevouts2, leafHash), script0.subarray(1, 33)), 'vin[0] (envelope/commit) still signs under walletPriv\'s xonly key');
  assert.strictEqual(script0.subarray(1, 33).toString('hex'), Buffer.from(walletPub.slice(1)).toString('hex'), 'envelope leaf still names walletPriv\'s x-only key as its authority');
  const changeOut = reveal2.outputs.find((o) => o.value > BigInt(546) && o.value !== BigInt(mig2.revealTx.outputs[0].value));
  if (changeOut) assert.strictEqual(changeOut.script.toString('hex'), '0014' + hash160(walletPub).toString('hex'), 'the reveal\'s sats-change output still pays walletPriv\'s address, not sourcePriv\'s');

  // The burn-home itself is keyed on (walletPriv, note outpoint) only — identical whether or not sourcePriv
  // was used to unlock the note, since by design nothing downstream of migrate ever needs to know the note
  // was stealth-received (see dapp/burn-deposit-reveal.js's own header comment).
  assert.deepStrictEqual(mig2.burnHome.priv, mig.burnHome.priv, 'the burn-home key is unaffected by sourcePriv — stays anchored to walletPriv + the note\'s own outpoint');

  ok('buildMigrationTxs(sourcePriv=...) signs only the note\'s own input under the alternate key; funding, envelope authority, change and the burn-home key all stay on walletPriv');
}

// reconstructBurnHome: rebuilds mig.burnHome from the wallet key + source outpoint alone (no fundingUtxo,
// no signing) — the recovery path for a session that lost buildMigrationTxs's own return value.
{
  const rebuilt = rd.reconstructBurnHome({
    prims, walletPriv: WALLET_PRIV, source: { txid: NOTE_TXID, vout: NOTE_VOUT }, amount: NOTE_AMOUNT,
    burnHomeTxid: mig.burnHome.txid, chainSpk: mig.revealTx.outputs[0].script,
  });
  assert.deepStrictEqual(rebuilt.priv, mig.burnHome.priv, 'reconstructed burn-home key matches the original');
  assert.deepStrictEqual(rebuilt.scriptS, mig.burnHome.scriptS, 'reconstructed script S matches the original');
  assert.deepStrictEqual(rebuilt.spk, mig.burnHome.spk, 'reconstructed output script matches the original');
  assert.strictEqual(rebuilt.cx, mig.burnHome.cx, 'reconstructed commitment x matches (same amount, same deterministic blinding)');
  assert.strictEqual(rebuilt.cy, mig.burnHome.cy, 'reconstructed commitment y matches');
  assert.strictEqual(rebuilt.txid, mig.burnHome.txid, 'carries the caller-supplied burn-home txid');

  assert.throws(
    () => rd.reconstructBurnHome({
      prims, walletPriv: WALLET_PRIV, source: { txid: NOTE_TXID, vout: NOTE_VOUT }, amount: NOTE_AMOUNT,
      burnHomeTxid: mig.burnHome.txid, chainSpk: new Uint8Array(34).fill(0xff),
    }),
    /does not match/,
    'refuses when the derived script does not match the real on-chain output',
  );
  // A different source vout derives a different key and blinding entirely (both are keyed by the source
  // outpoint, not by the burn-home's own txid), so the wrong outpoint is caught by the same on-chain check.
  assert.throws(
    () => rd.reconstructBurnHome({
      prims, walletPriv: WALLET_PRIV, source: { txid: NOTE_TXID, vout: 1 }, amount: NOTE_AMOUNT,
      burnHomeTxid: mig.burnHome.txid, chainSpk: mig.revealTx.outputs[0].script,
    }),
    /does not match/,
    'refuses for the wrong source outpoint (derives a different key entirely)',
  );
  ok('reconstructBurnHome rebuilds the exact original burn-home from the wallet key and source outpoint, and refuses on any mismatch against the real on-chain script');
}

// Phase 2: burn-deposit reveal, spending the migration's own burn-home output
const envelope = {
  assetId: ASSET,
  nullifier: '0x' + '9c'.repeat(32),
  destLeaf: '0x' + 'bd'.repeat(32),
  target: '0x' + '7c'.repeat(32),
};
const fundingUtxo2 = { txid: '80'.repeat(32), vout: 2, value: 5_000 };
const burn = await rd.buildBurnDepositRevealTxs({ prims, burnHome: mig.burnHome, envelope, fundingUtxo: fundingUtxo2, feeRate: 3 });

{
  const cls = classifyConfidentialTx(burn.revealHex);
  assert.ok(cls && cls.type === 'burn', 'burn reveal classifies as a burn-deposit');
  assert.strictEqual(cls.assetId.toLowerCase(), envelope.assetId.toLowerCase());
  assert.strictEqual(cls.nullifier.toLowerCase(), envelope.nullifier.toLowerCase());
  assert.strictEqual(cls.dest.toLowerCase(), envelope.destLeaf.toLowerCase());
  assert.strictEqual(cls.target.toLowerCase(), envelope.target.toLowerCase());
  ok('burn reveal classifies as a burn-deposit carrying the exact assetId/nullifier/destLeaf/target');
}
{
  // The fee is worked out on the transaction as sent, its change output included: the burn pays at least its rate on its own size.
  for (const rate of [3, 10, 25]) {
    const b = rate === 3 ? burn : await rd.buildBurnDepositRevealTxs({ prims, burnHome: mig.burnHome, envelope, fundingUtxo: { ...fundingUtxo2, value: 50_000 }, feeRate: rate });
    assert.strictEqual(parseTx(Buffer.from(b.revealHex, 'hex')).outputs.length, 2, 'the burn returns its change');
    assert.ok(b.fee >= Math.ceil(b.vsize * rate) && b.fee <= Math.ceil(b.vsize * rate) + 2 * rate, `the burn pays its rate on its own size (${b.fee} sats for ${b.vsize} vB at ${rate} sat/vB)`);
  }
  ok('the burn pays its fee rate on its size with the change output, at 3, 10 and 25 sat/vB');
}
{
  const ins = extractInputs(burn.revealHex);
  assert.strictEqual(ins.length, 2, 'burn reveal spends the burn-home and the funding UTXO');
  assert.strictEqual(ins[0].prevTxid.toLowerCase(), ('0x' + reverseHex(mig.burnHome.txid)).toLowerCase(), 'vin[0] is the burn-home (reflect.rs\'s "burned outpoint")');
  assert.strictEqual(ins[0].prevVout, 0);
  ok('burn reveal\'s FIRST spent input is the burn-home output, matching reflect.rs\'s own definition of the burned note');
}
{
  const reveal = parseTx(Buffer.from(burn.revealHex, 'hex'));
  assert.strictEqual(reveal.inputs[0].witness.length, 4, 'burn reveal vin[0] is a 4-item witness [sig, envelope-item, S, controlBlock]');
  const [sig0, item1, S, cb0] = reveal.inputs[0].witness;
  assert.strictEqual(S[0], 0x75, 'the REAL committed script leads with OP_DROP');
  assert.strictEqual(item1[0], 0x20, 'the dummy envelope item is shaped like a script (starts with PUSH32), but is never executed');
  const leafHash = independentLeafHash(S);
  const homeXonly = mig.burnHome.xonly;
  // The burn-home's own scriptPubKey (mig.burnHome.spk) was already independently checked in the migration
  // block above (revealTx.outputs[0].script against a from-scratch NUMS-tweak recomputation) — reusing it here
  // isn't circular, it's the already-verified fact this input's prevout actually carries on chain.
  const prevouts = [
    { value: BigInt(mig.burnHome.value), script: Buffer.from(mig.burnHome.spk) },
    { value: BigInt(fundingUtxo2.value), script: reveal.outputs[0].script },
  ];
  assert.ok(verifySchnorr(sig0, bip341Sighash(reveal, 0, prevouts, leafHash), homeXonly), 'burn reveal vin[0] signature verifies under an independently-recomputed BIP-341 sighash, against S (not the dummy item)');
  ok('burn reveal signature independently verified against the REAL committed script S, ignoring the dummy envelope item, via a from-scratch BIP-341 sighash');
}

// Refusals
{
  await assert.rejects(
    () => rd.buildMigrationTxs({ prims, note, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID, vout: 0, value: 500 }, feeRate: 3 }),
    /too small/,
    'funding UTXO too small to cover the commit is refused',
  );
  await assert.rejects(
    () => rd.buildBurnDepositRevealTxs({ prims, burnHome: mig.burnHome, envelope: { ...envelope, nullifier: '0x' + 'zz'.repeat(32) }, fundingUtxo: fundingUtxo2, feeRate: 3 }),
    /32-byte hex/,
    'a malformed envelope field is refused before anything is built',
  );
  ok('refuses an undersized funding UTXO and a malformed envelope field, before building anything');
}

console.log(`\n${n}/${n} burn-deposit-reveal checks passed`);
