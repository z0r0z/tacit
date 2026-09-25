#!/usr/bin/env node
// Bitcoin-side bridge burn of a reflected note (dapp/bridge-burn-broadcast.js): builds and signs the commit/reveal
// with deterministic test keys, broadcasts through an injected recorder (no network), reads the reveal back with
// the JS mirror of the guest's parser, folds it through the reflection scan mirror, and mints it with
// confidential-bridge-mint.js — the Bitcoin → Ethereum round trip in JS, for an unbound (class 1) and a bound
// (class 2) note. Then every refusal.
//
// Run: node tests/bridge-burn-broadcast.test.mjs

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialBridgeMint, txidInternal } from '../dapp/confidential-bridge-mint.js';
import { makeBridgeBurnBroadcaster } from '../dapp/bridge-burn-broadcast.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { verifySchnorr } from '../dapp/bulletproofs.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { makeBurnDepositKit, classifyConfidentialTx, extractInputs } from '../dapp/burn-deposit-bitcoin.js';
import { computeTxid, computeMerkleRoot, mineHeader, makeCoinbaseForEnvTx } from './btc-mini.mjs';
import { secp as vsecp, hmac, sha256 as vsha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

// The host page sets this once (tacit.js); the wallet's ECDSA commit signatures need it.
if (!vsecp.etc.hmacSha256Sync) vsecp.etc.hmacSha256Sync = (k, ...m) => hmac(vsha256, k, concatBytes(...m));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const ct = makeConfidentialTransfer({ keccak256 });
const bm = makeConfidentialBridgeMint({ pool, ct });

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join('');

const ASSET = '0x' + 'a5'.repeat(32);
const OTHER_ASSET = '0x' + 'b6'.repeat(32);
const CHAIN_BINDING = '0x' + '7c'.repeat(32);
const WALLET_PRIV = new Uint8Array(32).fill(0x11);
const NOTE_PRIV = new Uint8Array(32).fill(0x22);
const NOTE_XONLY = '0x' + Buffer.from(secp.getPublicKey(NOTE_PRIV, true).slice(1)).toString('hex');
const DEST_OWNER = pool.nkToOwner('0x' + 'c5'.repeat(32));
const NOTE_TXID = '5e'.repeat(31) + '01';   // display order
const NOTE_VOUT = 1;
const NOTE_VALUE = 1_500_000n, NOTE_BLINDING = 0x9a9a9a9an;
const FEE = 12_000n;

// A wallet whose network I/O is recorded in memory: one plain-sats funding UTXO, a fixed fee rate.
function testWallet({ utxos = null, rate = 5 } = {}) {
  const sent = [];
  const box = {};
  const w = makeBtcWallet({
    priv: WALLET_PRIV, hrp: 'bc',
    fetchUtxos: async () => utxos || box.default,
    broadcastTx: async (hex) => { sent.push(hex); return 'ok'; },
    fetchFeeRate: async () => rate,
  });
  const spk = w.prims.bytesToHex(w.prims.p2wpkhScript(w.wallet.pub));
  box.default = [{ txid: '6f'.repeat(32), vout: 0, value: 50_000, scriptpubkey: spk, status: { confirmed: true } }];
  return { prims: w.prims, sent, spk };
}

// A reflection state holding the note live, loaded into the scan indexer the worker runs.
function reflectedIndexer({ bound }) {
  const idx = makeScanReflectionIndexer({ secp, keccak256, sha256, burnDepositKit: makeBurnDepositKit({ secp, keccak256, sha256 }) });
  const { cx, cy } = pool.commitXY(NOTE_VALUE, NOTE_BLINDING);
  const leaf = bound ? pool.btcNoteLeafBound(ASSET, cx, cy, NOTE_XONLY, CHAIN_BINDING) : pool.btcNoteLeaf(ASSET, cx, cy, NOTE_XONLY);
  const key = pool.outpointKey(txidInternal(NOTE_TXID), NOTE_VOUT);
  const otherKey = pool.outpointKey(txidInternal('77'.repeat(32)), 0);
  idx.load({
    noteLeaves: ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), leaf],
    liveTriples: [[key, pool.commitmentHash(cx, cy), ASSET, NOTE_XONLY, bound ? 1 : 0], [otherKey, '0x' + '0e'.repeat(32), ASSET, '0x' + '0f'.repeat(32), 0]].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)),
    coords: [[key.toLowerCase(), { cx, cy }]],
    height: 100,
  });
  return { idx, leaf, key };
}

// ── an independent segwit parser and BIP-341 SIGHASH_DEFAULT message, for checking the builder's bytes ──
const sha = (b) => createHash('sha256').update(b).digest();
const tagged = (tag, msg) => { const t = sha(Buffer.from(tag)); return sha(Buffer.concat([t, t, msg])); };
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
  const witStart = p;
  if (segwit) for (const inp of inputs) for (let k = vi(); k > 0; k--) inp.witness.push(bytes(vi()));
  const locktime = u32();
  assert.strictEqual(p, b.length, 'tx parses exactly');
  return { version, inputs, outputs, locktime, totalSize: b.length, baseSize: b.length - (segwit ? 2 + (p - 4 - witStart) : 0) };
}
function bip341Sighash(tx, idx, prevouts, leafHash) {
  const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); return x; };
  const u64 = (v) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(BigInt(v)); return x; };
  const msg = [Buffer.from([0x00, 0x00]), u32(tx.version), u32(tx.locktime),
    sha(Buffer.concat(tx.inputs.map((i) => Buffer.concat([i.txid, u32(i.vout)])))),
    sha(Buffer.concat(prevouts.map((o) => u64(o.value)))),
    sha(Buffer.concat(prevouts.map((o) => Buffer.concat([varintBuf(o.script.length), o.script])))),
    sha(Buffer.concat(tx.inputs.map((i) => u32(i.sequence)))),
    sha(Buffer.concat(tx.outputs.map((o) => Buffer.concat([u64(o.value), varintBuf(o.script.length), o.script])))),
    Buffer.from([leafHash ? 0x02 : 0x00]), u32(idx)];
  if (leafHash) msg.push(leafHash, Buffer.from([0x00]), u32(0xffffffff));
  return tagged('TapSighash', Buffer.concat(msg));
}
function scriptPushes(s) {
  const out = []; let p = 36; // after PUSH32 key OP_CHECKSIG OP_FALSE OP_IF
  while (s[p] !== 0x68) { const op = s[p++]; const n = op <= 75 ? op : op === 0x4c ? s[p++] : (p += 2, s.readUInt16LE(p - 2)); out.push(s.subarray(p, p + n)); p += n; }
  assert.strictEqual(p, s.length - 1, 'script ends at OP_ENDIF');
  return out;
}

const note = { txid: NOTE_TXID, vout: NOTE_VOUT, sats: 330, asset: ASSET, value: NOTE_VALUE, blinding: NOTE_BLINDING };
const destBlinding = 0x5151n;

async function roundTrip({ bound }) {
  const { idx, leaf } = reflectedIndexer({ bound });
  const snapshot = idx.snapshot();
  const w = testWallet();
  const burner = makeBridgeBurnBroadcaster({ pool, bridgeMint: bm, prims: w.prims });
  const r = await burner.broadcastBridgeBurn({
    note, notePriv: NOTE_PRIV, chainBinding: CHAIN_BINDING, fee: FEE, snapshot,
    dest: { owner: DEST_OWNER, blinding: destBlinding }, isSpendable: () => true,
  });
  const tag = bound ? 'class 2' : 'class 1';

  // Broadcast: commit then reveal, through the injected standard broadcaster.
  assert.strictEqual(w.sent.length, 2, 'commit and reveal broadcast');
  assert.strictEqual(w.sent[0], r.commitHex); assert.strictEqual(w.sent[1], r.revealHex);
  assert.strictEqual(r.sourceClass, bound ? 2 : 1);

  // The reveal, read the way the guest reads it.
  const dec = classifyConfidentialTx(r.revealHex);
  assert.ok(dec && dec.type === 'burn', `${tag}: the reveal classifies as a bridge burn`);
  const nu = pool.nullifier(leaf);
  assert.strictEqual(dec.assetId, ASSET, 'envelope asset');
  assert.strictEqual(dec.nullifier, nu, 'envelope ν is the note leaf\'s nullifier');
  assert.strictEqual(dec.target, CHAIN_BINDING, 'envelope target is the pool chain binding');
  const dCommit = pool.commitXY(NOTE_VALUE - FEE, destBlinding);
  const destLeaf = pool.leaf(ASSET, dCommit.cx, dCommit.cy, DEST_OWNER);
  assert.strictEqual(dec.dest, destLeaf, 'envelope destLeaf commits to the burned value net of the fee');
  assert.strictEqual(r.dest.value, NOTE_VALUE - FEE);
  const ins = extractInputs(r.revealHex);
  assert.strictEqual(ins.length, 2, 'reveal spends the commit output and the note');
  assert.strictEqual(ins[0].prevTxid, '0x' + reverseHex(r.commitTxid), 'vin[0] is the commit output (the envelope)');
  assert.strictEqual(ins[0].prevVout, 0);
  assert.strictEqual(ins[1].prevTxid, txidInternal(NOTE_TXID), 'vin[1] is the burned note');
  assert.strictEqual(ins[1].prevVout, NOTE_VOUT);
  const burnId = pool.bridgeBurnId(1, txidInternal(NOTE_TXID), NOTE_VOUT, leaf, CHAIN_BINDING);
  assert.strictEqual(r.burnId, burnId, 'burnId = bridge_burn_id(REFLECTED, outpoint, source leaf, target)');
  ok(`${tag}: the reveal carries a 161-byte 0x2B burn at vin[0] with the expected asset, ν, destLeaf, target and burnId`);

  // Consensus and policy, recomputed from the bytes with an independent parser and BIP-341 sighash.
  const revealBytes = Buffer.from(r.revealHex, 'hex');
  const commit = parseTx(Buffer.from(r.commitHex, 'hex'));
  const reveal = parseTx(revealBytes);
  const [sig0, script, cb] = reveal.inputs[0].witness;
  assert.strictEqual(reveal.inputs[0].witness.length, 3, 'vin[0] is a script-path spend [sig, script, control block]');
  assert.strictEqual(sig0.length, 64, 'SIGHASH_DEFAULT signature; the only initial stack item, under 80 bytes');
  assert.strictEqual(cb.length, 33, 'control block for a single-leaf tree');
  const pushes = scriptPushes(script);
  assert.ok(pushes.every((p) => p.length <= 520), 'every push within 520 bytes');
  assert.strictEqual(reveal.inputs[1].witness.length, 1, 'vin[1] is a key-path spend');
  assert.strictEqual(reveal.inputs[1].witness[0].length, 64);
  // The commit output is P2TR(NUMS, leaf(script)).
  const leafHash = tagged('TapLeaf', Buffer.concat([Buffer.from([0xc0]), varintBuf(script.length), script]));
  const NUMS = cb.subarray(1);
  const Q = secp.ProjectivePoint.fromHex('02' + NUMS.toString('hex')).add(secp.ProjectivePoint.BASE.multiply(BigInt('0x' + tagged('TapTweak', Buffer.concat([NUMS, leafHash])).toString('hex'))));
  const qx = Buffer.from(Q.toRawBytes(true)).subarray(1);
  assert.strictEqual(commit.outputs[0].script.toString('hex'), '5120' + qx.toString('hex'), 'commit output commits to the envelope leaf');
  assert.strictEqual(cb[0], 0xc0 | (Q.toRawBytes(true)[0] === 0x03 ? 1 : 0), 'control block parity');
  const prevouts = [
    { value: commit.outputs[0].value, script: commit.outputs[0].script },
    { value: BigInt(note.sats), script: Buffer.from('5120' + NOTE_XONLY.slice(2), 'hex') },
  ];
  assert.ok(verifySchnorr(sig0, bip341Sighash(reveal, 0, prevouts, leafHash), script.subarray(1, 33)), 'vin[0] signature verifies under the envelope key');
  assert.ok(verifySchnorr(reveal.inputs[1].witness[0], bip341Sighash(reveal, 1, prevouts, null), Buffer.from(NOTE_XONLY.slice(2), 'hex')), 'vin[1] signature verifies under the note\'s auth key');
  const vsize = (tx) => Math.ceil((tx.baseSize * 3 + tx.totalSize) / 4);
  const revealFee = Number(prevouts[0].value + prevouts[1].value - reveal.outputs.reduce((s, o) => s + o.value, 0n));
  assert.strictEqual(revealFee, r.revealFee);
  assert.ok(revealFee >= 5 * vsize(reveal), 'reveal pays at least the requested 5 sat/vB');
  assert.ok([...reveal.outputs, ...commit.outputs].every((o) => o.value >= 546n), 'no dust outputs');
  assert.ok(reveal.version === 2 && commit.version === 2);
  ok(`${tag}: signatures verify (independent BIP-341 sighash), commit commits to the leaf, fee rate met, no dust, pushes within 520`);

  // Fold the reveal through the reflection scan mirror (the worker's indexer + the assembler).
  const revealTxid = computeTxid(revealBytes);
  assert.strictEqual(Buffer.from(revealTxid).reverse().toString('hex'), r.revealTxid, 'txid agrees with an independent computation');
  const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(revealBytes);
  const header = mineHeader(computeMerkleRoot([cbTxid, revealTxid]));
  const block = {
    txs: [
      { txidDisplay: Buffer.from(cbTxid).reverse().toString('hex'), rawHex: coinbaseSpec.txData.slice(2), vins: [], decode: null },
      { txidDisplay: r.revealTxid, rawHex: r.revealHex, vins: ins.map((i) => ({ prevTxidDisplay: reverseHex(i.prevTxid), vout: i.prevVout })), decode: dec },
    ],
  };
  await idx.assembleBlocks([block], { headers: ['0x' + Buffer.from(header).toString('hex')], anchorHeight: 101, chainBinding: CHAIN_BINDING });
  const st = idx.state();
  assert.ok(st.spentContains(nu), 'the note is nullified');
  assert.ok(st.burnContains(burnId), 'the burn set holds the burnId');
  ok(`${tag}: the reflection mirror folds it: note nullified, burnId recorded`);

  // Mint it on Ethereum from the folded state, with the fee carried in the note.
  const snap2 = idx.snapshot();
  const mint = bm.buildBridgeMintOp({ ...r.mintArgs, snapshot: { noteLeaves: snap2.noteLeaves, burnNodes: snap2.burnNodes } });
  assert.strictEqual(mint.fee, FEE, 'mint fee = burned − destination');
  assert.strictEqual(mint.burnId, burnId, 'mint names the same burn');
  assert.strictEqual(mint.destLeaf, destLeaf);
  assert.strictEqual(mint.sourceClass, bound ? 2 : 1);
  assert.strictEqual(mint.nullifier, nu);
  ok(`${tag}: buildBridgeMintOp finds the burn and mints the destination with fee ${FEE}`);
  return { snapshot, burner };
}

const { snapshot: snap1, burner } = await roundTrip({ bound: false });
const { snapshot: snap2 } = await roundTrip({ bound: true });

// ── refusals: nothing is built or broadcast ──
{
  const base = { note, notePriv: NOTE_PRIV, chainBinding: CHAIN_BINDING, fee: FEE, snapshot: snap1, dest: { owner: DEST_OWNER, blinding: destBlinding }, isSpendable: () => true };
  const w = testWallet();
  const refuse = async (over, re, what) => {
    await assert.rejects(() => burner.broadcastBridgeBurn({ ...base, prims: w.prims, ...over }), re, what);
    assert.strictEqual(w.sent.length, 0, `${what}: nothing broadcast`);
  };
  await refuse({ snapshot: { ...snap1, liveTriples: snap1.liveTriples.filter((t) => t[3] !== NOTE_XONLY) } }, /not in the reflected live set/, 'not yet reflected');
  await refuse({ sourceClass: 2 }, /class 1 .*not class 2/, 'wrong class');
  await refuse({ sourceClass: 0 }, /burn-deposit/, 'class 0 is a burn-deposit');
  await refuse({ fee: 12_345n }, /fee ladder/, 'off-ladder fee');
  await refuse({ fee: NOTE_VALUE }, /below the burned value/, 'fee consumes the note');
  await refuse({ dest: { owner: DEST_OWNER, blinding: destBlinding, value: NOTE_VALUE } }, /net of the fee/, 'destination not net of fee');
  await refuse({ dest: { owner: hex32(0), blinding: destBlinding } }, /dest.owner/, 'zero destination owner');
  await refuse({ dest: { owner: DEST_OWNER } }, /dest.blinding or deriveDestBlinding/, 'no destination blinding');
  await refuse({ note: { ...note, blinding: NOTE_BLINDING + 1n } }, /opening/, 'wrong opening');
  await refuse({ note: { ...note, asset: OTHER_ASSET } }, /asset/, 'wrong asset');
  await refuse({ notePriv: new Uint8Array(32).fill(0x33) }, /auth key/, 'key is not the note\'s auth key');
  await refuse({ note: { ...note, script: '5120' + 'ab'.repeat(32) } }, /P2TR output of notePriv/, 'script is not the key\'s P2TR');
  await refuse({ chainBinding: hex32(0) }, /chainBinding/, 'zero chain binding');
  await refuse({ feeRate: 0.5 }, /minimum relay rate/, 'fee rate under 1 sat/vB');
  ok('refuses: unreflected note, wrong class, burn-deposit class, off-ladder / oversized fee, destination not net of fee, bad owner / blinding, wrong opening / asset / key / script, zero binding, sub-relay fee rate');
}
{
  // A bound note burned toward a different deployment: its leaf is not in the tree under that binding.
  const w = testWallet();
  const other = '0x' + '7d'.repeat(32);
  await assert.rejects(() => burner.broadcastBridgeBurn({ note, notePriv: NOTE_PRIV, chainBinding: other, fee: FEE, snapshot: snap2, prims: w.prims, dest: { owner: DEST_OWNER, blinding: destBlinding } }), /bound to/, 'bound note, other binding');
  assert.strictEqual(w.sent.length, 0);
  ok('refuses a bound note burned toward a deployment it is not bound to');
}
{
  // Coin selection never spends a reflected note, a cBTC lock or the note itself as funding.
  const liveFunding = { txid: '77'.repeat(32), vout: 0, value: 90_000, status: { confirmed: true } };
  const noteAsFunding = { txid: NOTE_TXID, vout: NOTE_VOUT, value: 90_000, status: { confirmed: true } };
  const w = testWallet({ utxos: [liveFunding, noteAsFunding] });
  await assert.rejects(() => burner.broadcastBridgeBurn({ note, notePriv: NOTE_PRIV, chainBinding: CHAIN_BINDING, fee: FEE, snapshot: snap1, prims: w.prims, dest: { owner: DEST_OWNER, blinding: destBlinding }, isSpendable: () => true }), /insufficient plain sats/, 'only reflected notes available');
  assert.strictEqual(w.sent.length, 0);
  // Without an explicit list or a plain-sats filter, funding is refused rather than guessed.
  const w3 = testWallet();
  await assert.rejects(() => burner.broadcastBridgeBurn({ note, notePriv: NOTE_PRIV, chainBinding: CHAIN_BINDING, fee: FEE, snapshot: snap1, prims: w3.prims, dest: { owner: DEST_OWNER, blinding: destBlinding } }), /isSpendable/, 'no funding filter');
  assert.strictEqual(w3.sent.length, 0);
  const w2 = testWallet({ utxos: [liveFunding] });
  const b = await burner.buildBridgeBurnTxs({ note, notePriv: NOTE_PRIV, chainBinding: CHAIN_BINDING, fee: FEE, snapshot: snap1, prims: w2.prims, dest: { owner: DEST_OWNER, blinding: destBlinding }, fundingUtxos: [{ txid: '6f'.repeat(32), vout: 3, value: 20_000, scriptpubkey: w2.spk }, liveFunding] });
  assert.strictEqual(b.commitTx.inputs.length, 1);
  assert.strictEqual(b.commitTx.inputs[0].txid, '6f'.repeat(32), 'funded from plain sats only');
  assert.strictEqual(w2.sent.length, 0, 'buildBridgeBurnTxs does not broadcast');
  ok('coin selection skips reflected notes and the burned note; build-only does not broadcast');
}
{
  // A failed reveal broadcast keeps the signed reveal so it can be retried as is.
  const w = testWallet();
  let calls = 0;
  const prims = { ...w.prims, broadcastWithRetry: async () => { calls++; throw new Error('mempool full'); } };
  const e = await burner.broadcastBridgeBurn({ note, notePriv: NOTE_PRIV, chainBinding: CHAIN_BINDING, fee: FEE, snapshot: snap1, prims, dest: { owner: DEST_OWNER, blinding: destBlinding }, isSpendable: () => true }).catch((x) => x);
  assert.ok(e instanceof Error && /reveal failed/.test(e.message) && e.revealHex && e.commitTxid, 'error carries the commit txid and the signed reveal');
  assert.strictEqual(calls, 1);
  ok('a failed reveal broadcast surfaces the commit txid and the signed reveal for a retry');
}

{
  // The pool UX entry: reads the reflected state from the relay's dump and targets the pool's own chain binding.
  const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
  const urls = [];
  const fetchImpl = async (u) => { urls.push(String(u)); return { ok: true, json: async () => ({ attestedHeight: 100, snapshot: snap1 }) }; };
  const ux = makeConfidentialPoolUx({ secp, keccak256, sha256, network: 'mainnet', fetchImpl });
  const w = testWallet();
  const r = await ux.bridgeBurnToPool({ prims: w.prims, note, notePriv: NOTE_PRIV, fee: FEE, dest: { owner: DEST_OWNER, blinding: destBlinding }, isSpendable: () => true });
  assert.ok(urls.some((u) => /\/reflection\/dump\?network=mainnet$/.test(u)), 'reads GET /reflection/dump');
  assert.strictEqual(r.mintArgs.chainBinding, ux.chainBindingHex(), 'targets this pool');
  assert.strictEqual(w.sent.length, 2);
  assert.strictEqual(typeof ux.bridgeMint.bridgeMint, 'function');
  ok('ux.bridgeBurnToPool builds and broadcasts toward the pool\'s chain binding and returns the mint arguments');
}

console.log(`\n${n}/${n} bridge-burn-broadcast checks passed`);
