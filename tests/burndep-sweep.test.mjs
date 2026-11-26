#!/usr/bin/env node
// dapp/burn-deposit-reveal.js's buildSweepTx: the sats a bridge's first transaction holds go back to the key's own address when its second transaction
// can never be mined. Every claim is checked a second way: a from-scratch BIP-341 sighash and tx parser, as tests/burndep-cancel.test.mjs does.
//
// Run: node tests/burndep-sweep.test.mjs
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
await import('./_domshim.mjs');
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


// ==== buildSweepTx ====
const rd = makeBurnDepositReveal({ pool, secp });
const { prims } = testWallet();
const note = { assetId: ASSET, amount: NOTE_AMOUNT, blinding: NOTE_BLINDING, txid: NOTE_TXID, vout: NOTE_VOUT, sats: NOTE_SATS };
const mig = await rd.buildMigrationTxs({ prims, note, walletPriv: WALLET_PRIV, fundingUtxo: { txid: FUND_TXID, vout: 0, value: 38_000 }, feeRate: 3 });
const commitValue = mig.commitTx.outputs[0].value;

{
  const sw = await rd.buildSweepTx({ prims, commitHex: mig.commitHex, revealHex: mig.revealHex, walletPriv: WALLET_PRIV, feeRate: 3 });
  const parsed = parseTx(Buffer.from(sw.hex, 'hex'));
  ok(parsed.inputs.length === 1 && parsed.outputs.length === 1, 'one input, one output');
  ok(Buffer.from(parsed.inputs[0].txid).reverse().toString('hex') === stripHex(mig.commitTxid) && parsed.inputs[0].vout === 0 && sw.commitTxid === stripHex(mig.commitTxid), 'it spends the first transaction\'s first output');
  ok(commitValue > 37_000, 'sanity: the first transaction swallowed nearly the whole funding coin (' + commitValue + ' sats), which is what the sweep gives back');
  ok(Buffer.from(parsed.outputs[0].script).toString('hex') === Buffer.from(p2wpkhScript(WALLET_PUB)).toString('hex'), 'it pays the key\'s own address');
  ok(Number(parsed.outputs[0].value) === commitValue - sw.fee && sw.value === commitValue - sw.fee, 'the output is the held value less the fee, nothing else is taken');
  ok(sw.fee >= Math.ceil(sw.vsize * 3) && sw.fee <= Math.ceil(sw.vsize * 3) + 3, 'the fee is the rate times its size (' + sw.fee + ' sats for ' + sw.vsize + ' vB)');

  const wit = parsed.inputs[0].witness;
  ok(wit.length === 3 && wit[0].length === 64 && wit[2].length === 33, 'a script-path witness: signature, script, control block');
  const revealIn = parseTx(Buffer.from(mig.revealHex, 'hex')).inputs[0].witness;
  ok(Buffer.compare(wit[1], revealIn[1]) === 0, 'the script is the one the second transaction would have revealed');
  const commitSpk = Buffer.from(mig.commitTx.outputs[0].script);
  const leaf = independentLeafHash(wit[1]);
  const sighash = bip341Sighash(parsed, 0, [{ value: BigInt(commitValue), script: commitSpk }], leaf);
  ok(verifySchnorr(wit[0], sighash, WALLET_PUB.slice(1)), 'the signature verifies under an independent BIP-341 sighash against the real prevout');
  const { Q_xonly } = prims.tweakedOutputKey(prims.TAP_NUMS, prims.tapLeafHash(wit[1]));
  ok(Buffer.compare(Buffer.from(prims.p2trScript(Q_xonly)), commitSpk) === 0, 'script and control block commit to exactly the output being spent');
}

{
  const other = new Uint8Array(32).fill(0x44);
  let e = null; try { await rd.buildSweepTx({ prims, commitHex: mig.commitHex, revealHex: mig.revealHex, walletPriv: other, feeRate: 3 }); } catch (x) { e = x; }
  ok(e && /does not own/.test(e.message), 'another key is refused: it cannot sign for this script');
}
{
  const mig2 = await rd.buildMigrationTxs({ prims, note, walletPriv: WALLET_PRIV, fundingUtxo: { txid: '71'.repeat(32), vout: 0, value: 38_000 }, feeRate: 3 });
  let e = null; try { await rd.buildSweepTx({ prims, commitHex: mig2.commitHex, revealHex: mig.revealHex, walletPriv: WALLET_PRIV, feeRate: 3 }); } catch (x) { e = x; }
  ok(e && /does not spend/.test(e.message), 'a reveal that belongs to a different first transaction is refused');
}
{
  const small = await rd.buildMigrationTxs({ prims, note: { ...note, sats: 6_000 }, walletPriv: WALLET_PRIV, fundingUtxo: { txid: '72'.repeat(32), vout: 0, value: 1_300 }, feeRate: 3 });
  let e = null; try { await rd.buildSweepTx({ prims, commitHex: small.commitHex, revealHex: small.revealHex, walletPriv: WALLET_PRIV, feeRate: 3 }); } catch (x) { e = x; }
  ok(e && e.code === 'small' && Number(e.commitValue) === small.commitTx.outputs[0].value, 'a first transaction holding too little to be worth moving says so, with a code');
  let e2 = null; try { await rd.buildSweepTx({ prims, commitHex: mig.commitHex, revealHex: mig.revealHex, walletPriv: WALLET_PRIV, feeRate: 0.01 }); } catch (x) { e2 = x; }
  ok(e2 && /minimum relay rate/.test(e2.message), 'a rate under the relay minimum is refused');
}

console.log(failures ? `\n${failures} FAILURES (${n} passed)` : `\nall ${n} burndep-sweep checks passed`);
process.exit(failures ? 1 : 0);
