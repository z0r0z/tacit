#!/usr/bin/env node
// dapp/burn-deposit-reveal.js's buildCancelTx + dapp/burndep-ux.js's buildCancel: reclaiming a stuck
// burn-home by moving its value into an ORDINARY note via a real cxfer (an "un-migrate"), once
// migrate-confirmed lands but the flow can never reach the real burn.
//
// An earlier version of this reclaim spent the burn-home with a bare signature, no envelope at all. It
// shipped, was reverted after review found the real value would never land anywhere recognized (see the git
// log for that revert). The one check that would have caught it immediately is classifyConfidentialTx
// returning null for a bare payment — that check is now the FIRST thing this file verifies, not an
// afterthought, and it is asserted directly against dapp/burn-deposit-bitcoin.js's real classifier, not a
// stand-in.
//
// Same fixture pattern as tests/burn-deposit-reveal.test.mjs (real wallet, real secp256k1/Taproot signing)
// and tests/burndep-ux.test.mjs (the in-memory "world" for the state-machine wiring), plus this file's own
// from-scratch Script-stack simulator for the witness-depth claim and a from-scratch BIP-341 sighash for the
// signature claim — the builder's own self-checks are useful, but every claim here is also verified a second,
// independent way.
//
// Run: node tests/burndep-cancel.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeBurnDepositReveal } from '../dapp/burn-deposit-reveal.js';
import { makeBurnDepositUx } from '../dapp/burndep-ux.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { verifySchnorr } from '../dapp/bulletproofs.js';
import { extractInputs, classifyConfidentialTx, extractTaprootEnvelope } from '../dapp/burn-deposit-bitcoin.js';
import { secp as vsecp, hmac as vhmac, sha256 as vsha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

if (!vsecp.etc.hmacSha256Sync) vsecp.etc.hmacSha256Sync = (k, ...m) => vhmac(vsha256, k, concatBytes(...m));

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const stripHex = (h) => String(h).replace(/^0x/, '');
const reverseHex = (h) => stripHex(h).match(/../g).reverse().join('');
const withHex = (h) => '0x' + stripHex(h);
const hexToBytes = (h) => { const s = stripHex(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };

// ---- load dapp/tacit.js under a DOM shim for the pure cxfer/BPP helpers only (see burn-deposit-reveal.js's
// own header comment on why only these, never anything wallet-stateful, come from tacit.js) ----
const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import('../scratchpad/domshim2.mjs');
globalThis.fetch = realFetch; globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
const tacit = await import('../dapp/tacit.js');
const {
  encodeCXferBppPayload, decodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf,
  encryptAmount, decryptAmount, signSchnorr, modN, p2wpkhScript,
} = tacit;

const ASSET = withHex('a5'.repeat(32));
const WALLET_PRIV = new Uint8Array(32).fill(0x33);
const WALLET_PUB = secp.getPublicKey(WALLET_PRIV, true);
const NOTE_TXID = '5e'.repeat(31) + '06';
const NOTE_VOUT = 0;
const NOTE_AMOUNT = 900_000n, NOTE_BLINDING = 0x99999999n, NOTE_SATS = 1_000;
const FUND_TXID = '6b'.repeat(32);

function testWallet({ rate = 3 } = {}) {
  const w = makeBtcWallet({
    priv: WALLET_PRIV, hrp: 'bc',
    fetchUtxos: async () => [],
    broadcastTx: async () => 'ok',
    fetchFeeRate: async () => rate,
  });
  const extended = {
    ...w.prims, sha256,
    encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount,
    signSchnorr, modN,
  };
  return { prims: extended, wallet: w.wallet };
}

// ---- independent BIP-341 sighash + tx parser, to check the builder's bytes without trusting its own checks
// (copied verbatim from tests/burn-deposit-reveal.test.mjs, which already solved this) ----
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

// Minimal Script interpreter for EXACTLY the 3 opcodes homeScriptS uses (OP_DROP, a 32-byte PUSH, OP_CHECKSIG)
// -- not a general Bitcoin Script VM, just enough to mechanically prove the witness-stack depth buildCancelTx
// relies on, independent of the signature check above.
function simulateHomeScriptS(scriptBytes, preScriptStack) {
  const stack = preScriptStack.map((x) => x);
  let p = 0;
  if (scriptBytes[p] !== 0x75) return { ok: false, reason: 'script does not start with OP_DROP' };
  p += 1;
  if (stack.length < 1) return { ok: false, reason: 'OP_DROP: stack is empty' };
  stack.pop();
  if (scriptBytes[p] !== 0x20) return { ok: false, reason: 'script does not push exactly 32 bytes next' };
  const pushLen = scriptBytes[p]; p += 1;
  const pushed = scriptBytes.slice(p, p + pushLen); p += pushLen;
  stack.push(pushed);
  if (scriptBytes[p] !== 0xac) return { ok: false, reason: 'script does not end with OP_CHECKSIG' };
  if (stack.length < 2) return { ok: false, reason: `OP_CHECKSIG needs 2 stack items (sig, pubkey), only ${stack.length} available` };
  const pubkey = stack.pop();
  const sigFound = stack.pop();
  return { ok: true, sigFound, pubkey };
}

// ==== the actual tests ====
const rd = makeBurnDepositReveal({ pool, secp });
const { prims } = testWallet();

// Build a real burn-home via the real migration path (same fixture every other burn-deposit-reveal test uses).
const note = { assetId: ASSET, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING, txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS };
const fundingUtxo1 = { txid: FUND_TXID, vout: 0, value: 30_000 };
const mig = await rd.buildMigrationTxs({ prims, note, walletPriv: WALLET_PRIV, fundingUtxo: fundingUtxo1, feeRate: 3 });

const burnHome = rd.reconstructBurnHome({
  prims, walletPriv: WALLET_PRIV, source: { txid: NOTE_TXID, vout: NOTE_VOUT }, amount: NOTE_AMOUNT,
  burnHomeTxid: mig.burnHome.txid, chainSpk: mig.revealTx.outputs[0].script,
});

// ---- mechanical proof of the witness-stack shape, before trusting anything buildCancelTx signs ----
{
  const SIG_PLACEHOLDER = new Uint8Array(64).fill(0xab);
  const EMPTY_PLACEHOLDER = new Uint8Array(0);
  const fourItem = simulateHomeScriptS(burnHome.scriptS, [SIG_PLACEHOLDER, EMPTY_PLACEHOLDER]);
  assert.ok(fourItem.ok, 'a 4-item witness [sig, dummy, S, controlBlock] must leave OP_CHECKSIG a well-formed stack');
  ok(true, 'mechanically executing homeScriptS against a 4-item witness leaves OP_CHECKSIG a valid [sig, pubkey] stack, regardless of any envelope');

  const threeItem = simulateHomeScriptS(burnHome.scriptS, [SIG_PLACEHOLDER]);
  ok(threeItem.ok === false, 'a dummy-less 3-item witness leaves OP_CHECKSIG stack-starved -- the dummy slot is load-bearing purely for Bitcoin\'s own script rules, independent of any envelope');
}

// ---- buildCancelTx: the built transaction is a REAL cxfer, recognized by the real classifier ----
{
  const fundingUtxo2 = { txid: '70'.repeat(32), vout: 1, value: 5_000 };
  const cancel = await rd.buildCancelTx({ prims, burnHome, assetId: ASSET, walletPriv: WALLET_PRIV, walletPub: WALLET_PUB, fundingUtxo: fundingUtxo2, feeRate: 3 });
  ok(typeof cancel.revealHex === 'string' && cancel.revealHex.length > 0, 'buildCancelTx returns a serialized reveal transaction');
  ok(cancel.revealFee > 0, 'reports a positive reveal fee');

  // THE check that would have caught the earlier mistake: the real indexer classifier, not a stand-in.
  const cls = classifyConfidentialTx('0x' + cancel.revealHex);
  ok(cls !== null, 'classifyConfidentialTx recognizes the built reveal as SOMETHING -- a bare payment (the earlier, reverted version) returns null here');
  ok(cls && cls.type === 'cxfer' && cls.opcode === 0x22, 'specifically: a real T_CXFER_BPP cxfer, not merely some recognized envelope');
  ok(cls && cls.assetId.toLowerCase() === ASSET.toLowerCase(), 'classified under the correct asset id');
  ok(cls && Array.isArray(cls.commitments) && cls.commitments.length === 1, 'carries exactly one output commitment');

  const parsed = parseTx(Buffer.from(cancel.revealHex, 'hex'));
  ok(parsed.inputs.length === 2, 'spends exactly two inputs');
  ok(parsed.outputs.length >= 1, 'has at least one output');
  ok(Number(parsed.outputs[0].value) === 546, 'output 0 (the reclaimed note) carries the DUST sats value, same as every other confidential note output -- the real value rides in the commitment, not the visible sats');
  ok(parsed.outputs[0].script.toString('hex') === Buffer.from(p2wpkhScript(WALLET_PUB)).toString('hex'), 'output 0 pays this wallet\'s own ordinary P2WPKH address -- an OUTSIDER could not tell it apart from any other plain payment');

  const ins = extractInputs('0x' + cancel.revealHex);
  ok(ins[1].prevTxid.toLowerCase() === withHex(reverseHex(burnHome.txid)).toLowerCase() && ins[1].prevVout === burnHome.vout, 'vin[1] is the burn-home outpoint -- the SEPARATE asset input CXFER structurally requires (unlike the burn envelope, which reads vin[0])');

  // vin[0]: the fresh envelope-commit input, standard 3-item script-path witness -- the real committed
  // script here IS the envelope (unlike vin[1] below).
  ok(parsed.inputs[0].witness.length === 3, 'vin[0] is a standard 3-item script-path witness [sig, script, controlBlock] -- the envelope carrier, no dummy needed');
  const [sig0, script0, cb0] = parsed.inputs[0].witness;

  // vin[1]: the burn-home itself, 4-item witness, dummy this time truly meaningless (this tx's real
  // envelope is entirely on vin[0]).
  ok(parsed.inputs[1].witness.length === 4, 'vin[1] (the burn-home) is a 4-item witness [sig, dummy, S, controlBlock]');
  const [sig1, dummy1, S1, cb1] = parsed.inputs[1].witness;
  ok(dummy1.length === 0, 'the dummy item on vin[1] is empty -- unlike the burn-deposit reveal\'s own dummy, it carries no envelope, since this transaction\'s real envelope is entirely on vin[0]');
  ok(S1[0] === 0x75 && Buffer.from(S1).toString('hex') === Buffer.from(burnHome.scriptS).toString('hex'), 'the REAL committed script on vin[1] is burnHome.scriptS itself');
  ok(Buffer.from(cb1).toString('hex') === Buffer.from(burnHome.controlBlock).toString('hex'), 'the control block on vin[1] is burnHome.controlBlock itself, unchanged from what reconstructBurnHome verified against the real on-chain output');

  // Independently reconstruct vin[0]'s own real prevout script from ITS OWN witness (script0 IS the real
  // committed leaf for a standard 3-item spend), using the same NUMS-tweak primitives buildCancelTx itself
  // uses -- so both signatures are verified against their REAL prevouts, not one trusted and one assumed.
  const { Q_xonly: envQ } = prims.tweakedOutputKey(prims.TAP_NUMS, prims.tapLeafHash(script0));
  const commitSpk = prims.p2trScript(envQ);
  const realPrevouts = [{ value: BigInt(cancel.commitTx.outputs[0].value), script: Buffer.from(commitSpk) }, { value: BigInt(burnHome.value), script: Buffer.from(burnHome.spk) }];

  // The in-script signature check is against the xonly key PUSHed inside the script itself (fundingXonly ==
  // this wallet's own xonly), NOT the tweaked output key envQ -- envQ is only the OUTPUT's own scriptPubKey
  // tweak, unrelated to what OP_CHECKSIG inside the script actually checks against.
  const leafHash0 = independentLeafHash(script0);
  assert.ok(verifySchnorr(sig0, bip341Sighash(parsed, 0, realPrevouts, leafHash0), WALLET_PUB.slice(1)), 'vin[0] signature independently verifies under a from-scratch BIP-341 sighash, against the envelope script it really commits to');
  ok(true, "vin[0]'s signature independently verified against its real prevout (the fresh envelope-commit output), not merely trusted from buildCancelTx's own internal check");

  const leafHash1 = independentLeafHash(S1);
  assert.ok(verifySchnorr(sig1, bip341Sighash(parsed, 1, realPrevouts, leafHash1), burnHome.xonly), 'vin[1] signature independently verifies under a from-scratch BIP-341 sighash, against S (ignoring the empty dummy) and burnHome.xonly, using vin INDEX 1 specifically -- the exact detail the earlier, buggier version of this function got wrong');
  ok(true, "vin[1]'s signature independently verified against burnHome's own real, already-chain-verified prevout script");

  // ---- the destination note is genuinely discoverable: re-deriving from JUST (walletPriv, burn-home
  // outpoint) reproduces the exact on-chain commitment and decrypts to the exact original amount ----
  const anchorBytes = Buffer.concat([Buffer.from(reverseHex(stripHex(burnHome.txid)), 'hex'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(burnHome.vout, 0); return b; })()]);
  const rediscoveredBlinding = deriveChangeBlinding(WALLET_PRIV, anchorBytes, 0);
  const rediscoveredKs = deriveAmountKeystreamSelf(WALLET_PRIV, anchorBytes, 0);
  ok(rediscoveredBlinding === cancel.note.blinding, 'the destination note\'s blinding is exactly re-derivable from (walletPriv, burn-home outpoint) alone -- no separate backup needed, same guarantee reconstructBurnHome already gives the burn-home itself');

  const { cx: rediscoveredCx, cy: rediscoveredCy } = pool.commitXY(burnHome.amount, rediscoveredBlinding);
  const { cx: onChainCx, cy: onChainCy } = pool.decompressCommitment(cls.commitments[0]);
  ok(rediscoveredCx.toLowerCase() === onChainCx.toLowerCase() && rediscoveredCy.toLowerCase() === onChainCy.toLowerCase(), 're-deriving (amount, blinding) from just the wallet key + burn-home outpoint reproduces the EXACT commitment the transaction actually put on chain');

  const envHex = extractTaprootEnvelope('0x' + cancel.revealHex);
  const decoded = decodeCXferBppPayload(hexToBytes(envHex));
  const recoveredAmount = decryptAmount(decoded.outputs[0].encryptedAmount, rediscoveredKs);
  ok(recoveredAmount === burnHome.amount, "decrypting the on-chain envelope's own encryptedAmount with the re-derived keystream recovers the EXACT original confidential amount -- the value that was stuck in the burn-home really does land in a note this wallet can rediscover and spend");
}

// ---- refusals ----
{
  await assert.rejects(
    () => rd.buildCancelTx({ prims, burnHome, assetId: ASSET, walletPriv: WALLET_PRIV, walletPub: WALLET_PUB, fundingUtxo: null, feeRate: 3 }),
    /fundingUtxo/,
    'refuses without a fundingUtxo',
  );
  ok(true, 'buildCancelTx refuses cleanly when no fundingUtxo is supplied at all');

  await assert.rejects(
    () => rd.buildCancelTx({ prims, burnHome, assetId: ASSET, walletPriv: WALLET_PRIV, walletPub: WALLET_PUB, fundingUtxo: { txid: '72'.repeat(32), vout: 0, value: 100 }, feeRate: 3 }),
    /funding UTXO too small|insufficient funds to cancel/,
    'refuses when the available value cannot cover a sane fee plus dust (either check may fire first, depending on exact vsize)',
  );
  ok(true, 'buildCancelTx refuses cleanly (does not build a broken transaction) when the available value is too small');

  await assert.rejects(
    () => rd.buildCancelTx({ prims, burnHome, assetId: '0x' + '00'.repeat(32), walletPriv: WALLET_PRIV, walletPub: WALLET_PUB, fundingUtxo: { txid: '73'.repeat(32), vout: 0, value: 5_000 }, feeRate: 3 }),
    /assetId/,
    'refuses a zero assetId',
  );
  ok(true, 'buildCancelTx refuses cleanly on a malformed assetId');
}

// ==== burndep-ux.js's buildCancel: the state-machine wiring on top of buildCancelTx ====
const kitHmac = (h, k, ...m) => hmac(nobleSha256, k, Buffer.concat(m.map((x) => Buffer.from(x))));
function makeMemStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

function makeWorld() {
  const chainTxs = new Map();
  const ripemd160ish = (pub) => sha256(pub).subarray(0, 20);
  const wpkhSpkOf = (pub) => '00' + '14' + Buffer.from(ripemd160ish(pub)).toString('hex');
  let migrateConfirmed = false;
  const WALLET_PUB_LOCAL = secp.getPublicKey(WALLET_PRIV, true);
  chainTxs.set(NOTE_TXID, { confirmed: true, vout: [{ scriptpubkey: wpkhSpkOf(WALLET_PUB_LOCAL) }] });

  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u.pathname === '/reflection/burndep/trace') {
      return json({ ok: true, hops: 1, bundle: { etch: { tx: '0x00', blockHash: 'aa'.repeat(32) }, cxfers: [{ tx: '0x00', txid: withHex('bb'.repeat(32)), inputs: [{ prevTxid: withHex(NOTE_TXID), prevVout: 0 }], outputs: [], rangeProof: '0x', kernelSig: '0x' }] } });
    }
    if (u.pathname === '/reflection/burndep/check') return json({ ok: true, admitted: true, reason: 'admitted' });
    if (u.pathname === '/reflection/burndep/status') return json(migrateConfirmed ? { ok: true, status: 'not-a-burn-deposit', burnBlockHeight: 900 } : { ok: true, status: 'unconfirmed' });
    if (u.pathname.startsWith('/chain/tx/')) {
      const txid = u.pathname.slice('/chain/tx/'.length);
      const rec = chainTxs.get(stripHex(txid));
      if (!rec) throw new Error('world: unknown chain tx ' + txid);
      return json({ status: { confirmed: rec.confirmed }, vout: rec.vout });
    }
    throw new Error('world: unstubbed path ' + u.pathname);
  };

  const chain = {
    getUtxos: async () => [{ txid: '74'.repeat(32), vout: 0, value: 5_000 }],
    pickSafeCommitSats: async (utxos) => utxos,
    broadcast: async () => 'txid',
    broadcastWithRetry: async () => 'txid',
    getFeeRate: async () => 3,
  };

  return {
    fetchImpl, chain,
    setBurnHomeOnChain: (txid, spkHex) => chainTxs.set(stripHex(txid), { confirmed: true, vout: [{ scriptpubkey: stripHex(spkHex) }] }),
    setMigrateConfirmed: (v) => { migrateConfirmed = v; },
  };
}

function makeUx(world, storage) {
  return makeBurnDepositUx({
    network: 'signet', hrp: 'tb', workerBase: 'https://worker.example', fetchImpl: world.fetchImpl, storage,
    secp, sha256, keccak256: keccak_256, hmac: kitHmac, pool,
    bridgeMint: { bridgeMint: async () => ({ jobId: 'job1', txHash: '0x' + 'cd'.repeat(32) }) },
    chainBindingHex: () => '7c'.repeat(32), tacAssetId: ASSET, chain: world.chain,
    encodeCXferBppPayload, computeKernelMsg, deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr, modN,
  });
}

// ---- gate: too early / too late / needs the key ----
{
  const world = makeWorld();
  const ux = makeUx(world, makeMemStorage());
  for (const stage of ['migrate-signed', 'migrate-sent']) {
    await assert.rejects(() => ux.buildCancel({ rec: { stage }, walletPriv: WALLET_PRIV }), /cannot cancel yet/, `refuses at stage '${stage}'`);
  }
  ok(true, 'buildCancel refuses cleanly at both pre-confirmation stages');

  for (const stage of ['burn-mined', 'registered', 'folded', 'minted']) {
    await assert.rejects(() => ux.buildCancel({ rec: { stage }, walletPriv: WALLET_PRIV }), /cannot cancel at stage/, `refuses at stage '${stage}'`);
  }
  ok(true, 'buildCancel refuses cleanly at every stage from burn-mined onward');

  await assert.rejects(() => ux.buildCancel({ rec: { stage: 'traced' }, walletPriv: null }), /needs the wallet key/, 'refuses without walletPriv');
  ok(true, 'buildCancel refuses cleanly when no wallet key is supplied');
}

// ---- end-to-end: a real record, driven for real through the state machine, actually cancels ----
{
  const world = makeWorld();
  const storage = makeMemStorage();
  const ux = makeUx(world, storage);

  let rec = await ux.start({
    note: { txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING },
    walletPriv: WALLET_PRIV, fundingUtxo: { txid: '75'.repeat(32), vout: 0, value: 30_000 }, feeRate: 3,
  });
  world.setBurnHomeOnChain(rec.burnHome.txid, rec.burnHome.spk);
  rec = await ux.advance(rec.walletPub, rec.id);
  world.setMigrateConfirmed(true);
  rec = await ux.advance(rec.walletPub, rec.id);
  ok(rec.stage === 'migrate-confirmed', 'sanity: the record reached migrate-confirmed');

  const cancel = await ux.buildCancel({ rec, walletPriv: WALLET_PRIV, feeRate: 3 });
  const cls = classifyConfidentialTx('0x' + cancel.revealHex);
  ok(cls && cls.type === 'cxfer' && cls.opcode === 0x22, 'end-to-end: buildCancel (via burndep-ux.js) produces a transaction the real classifier recognizes as a genuine cxfer');
  ok(cls.assetId.toLowerCase() === ASSET.toLowerCase(), 'end-to-end: classified under the correct (TAC) asset');
  const ins = extractInputs('0x' + cancel.revealHex);
  ok(ins[1].prevTxid.toLowerCase() === withHex(reverseHex(rec.burnHome.txid)).toLowerCase() && ins[1].prevVout === 0, 'end-to-end: vin[1] spends the record\'s own burn-home');
}

console.log(failures ? `\n${failures} FAILURES (${n} passed)` : `\nall ${n} burndep-cancel checks passed`);
process.exit(failures ? 1 : 0);
