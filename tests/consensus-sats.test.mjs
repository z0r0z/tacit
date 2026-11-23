// The Bitcoin transactions of a swap of plain sats, judged by Bitcoin Core's own script verifier (tests/consensus-sats, the bitcoinconsensus crate, Taproot
// rules on) and not by this repo's code: the lock's funding spend, the claim (key path), the refund (script path, OP_CHECKSEQUENCEVERIFY), and variants that
// the rules must refuse. The cases are made here from the builders in dapp/adaptor-btc-tx.js, so a change to a builder is judged by the node's rules the next
// time this runs. The refund's timelock is run at the edges of the script-number encoding too (1, 16, 17, 127, 128, 255, 256, 32767, 32768, 65535).
// What it does not judge: relay policy (minimum fee, dust, standardness) and the age of the output (BIP68), which are the mempool's and not the script's.
//   node tests/consensus-sats.test.mjs
//   needs cargo; the first run downloads the crate and builds it (about a minute). CARGO_TARGET_DIR keeps the build (default: a folder in the temp directory,
//   so none lands in the tree); CONSENSUS_BIN=<the built consensus-sats binary> skips the build. Without cargo the test says so and passes nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, bytesToHex as hx } from '../dapp/vendor/tacit-deps.min.js';
import { SECP_N, bigintToBytes32 } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../dapp/adaptor-btc-tx.js';
import { deriveLock, claimSecret } from '../dapp/adaptor-btc-lock.js';
import * as X from '../dapp/adaptor-xswap.js';

const ROOT = new URL('../', import.meta.url).pathname;
const MANIFEST = join(ROOT, 'tests/consensus-sats/Cargo.toml');
let bin = process.env.CONSENSUS_BIN || '';
if (!bin && spawnSync('cargo', ['--version']).status !== 0) { console.log('skip - needs cargo (or CONSENSUS_BIN=<the built consensus-sats binary>)'); process.exit(0); }

const te = (s) => new TextEncoder().encode(s);
const scalar = (t) => (BigInt('0x' + hx(sha256(te(t)))) % (SECP_N - 1n)) + 1n;
const wallet = (n) => makeBtcWallet({ priv: bigintToBytes32(scalar(n)), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1 }).prims;
const U = wallet('user'), L = wallet('lp');
const user = makeAdaptorBtcTx({ prims: U }), lp = makeAdaptorBtcTx({ prims: L });
const VALUE = 100_000, CSV = 144, FEE = 7;
const seed = sha256(te('seed'));
const coin = { txid: hx(sha256(te('funding coin'))), vout: 0, value: 200_000 };
const swapId = X.swapIdOf(coin.txid, coin.vout);
const sec = X.deriveSwapSecrets({ seed, swapId });
const lockFor = (csvBlocks) => deriveLock({ prims: U, claimerPub: L.wallet.pub, T: sec.T, lockerXonly: U.wallet.xonly(), csvBlocks });
const spkOf = (lock, value = VALUE) => `${hx(lock.spk)}:${value}`;
const coinSpk = `${hx(U.p2wpkhScript(U.wallet.pub))}:${coin.value}`;

// a transaction with one byte of one witness item changed, serialized again
const mutate = (pair, fn) => {
  const tx = { ...pair.revealTx, inputs: pair.revealTx.inputs.map((i) => ({ ...i, witness: i.witness.map((w) => Uint8Array.from(w)) })) };
  fn(tx);
  return hx(L.serializeTx(tx));
};

const lock = lockFor(CSV);
const hint = X.lockHintScript({ seed, swapId, claimerPub: L.wallet.pub, csvBlocks: CSV, value: VALUE, bare: true });
const lockPair = user.lockSats({ lock, amount: VALUE, hint, coins: [coin], feeRate: FEE });
const lockOut = { txid: lockPair.revealTxid, vout: 0, value: VALUE };
const claim = lp.claimSats({ lockOut, lock, sk: claimSecret({ dClaimer: L.wallet.priv, t: sec.t, lock }), feeRate: FEE });
const refund = user.refundSats({ lockOut, lock, dLocker: U.wallet.priv, feeRate: FEE });
// signed correctly, but with nSequence one short of what the leaf asks: the only thing wrong with it is the timelock
const early = user.refundSats({ lockOut, lock: { ...lock, csvBlocks: CSV - 1 }, dLocker: U.wallet.priv, feeRate: FEE });

const rows = [
  ['lock: the funding coin is spent by its P2WPKH signature (BIP143)', lockPair.revealHex, 'ok', [coinSpk]],
  ['claim: key path under the lock output key, with t', claim.revealHex, 'ok', [spkOf(lock)]],
  ['refund: script path, signature + leaf + control block, nSequence = 144', refund.revealHex, 'ok', [spkOf(lock)]],
  ['refund: nSequence 143 under a leaf that wants 144 (signed correctly)', early.revealHex, 'fail', [spkOf(lock)]],
  ['claim: one byte of the signature changed', mutate(claim, (t) => { t.inputs[0].witness[0][10] ^= 1; }), 'fail', [spkOf(lock)]],
  ['refund: one byte of the signature changed', mutate(refund, (t) => { t.inputs[0].witness[0][10] ^= 1; }), 'fail', [spkOf(lock)]],
  ['refund: control block parity flipped', mutate(refund, (t) => { t.inputs[0].witness[2][0] ^= 1; }), 'fail', [spkOf(lock)]],
  ['refund: leaf altered (timelock 145)', mutate(refund, (t) => { t.inputs[0].witness[1][1] ^= 1; }), 'fail', [spkOf(lock)]],
  ['claim: spent against a different amount than the output holds', claim.revealHex, 'fail', [spkOf(lock, VALUE + 1)]],
  ['lock: the funding coin spent against the wrong amount', lockPair.revealHex, 'fail', [`${hx(U.p2wpkhScript(U.wallet.pub))}:${coin.value + 1}`]],
];
// the refund's timelock at the edges of the script-number encoding: OP_1..OP_16, one byte, a byte that needs a sign byte, two and three bytes
for (const csv of [1, 16, 17, 72, 96, 127, 128, 144, 255, 256, 4032, 32767, 32768, 65535]) {
  const l = lockFor(csv), out = { txid: lockPair.revealTxid, vout: 0, value: VALUE };
  rows.push([`refund at timelock ${csv}: nSequence ${csv}`, user.refundSats({ lockOut: out, lock: l, dLocker: U.wallet.priv, feeRate: FEE }).revealHex, 'ok', [spkOf(l)]]);
  rows.push([`refund at timelock ${csv}: nSequence ${csv - 1}`, user.refundSats({ lockOut: out, lock: { ...l, csvBlocks: csv - 1 }, dLocker: U.wallet.priv, feeRate: FEE }).revealHex, 'fail', [spkOf(l)]]);
}
// a generator that makes every case refuse, or none, would pass for nothing
assert.ok(rows.filter((r) => r[2] === 'ok').length >= 17 && rows.filter((r) => r[2] === 'fail').length >= 21, 'the cases are a mix of accepted and refused');

const dir = mkdtempSync(join(tmpdir(), 'consensus-sats-'));
const casesFile = join(dir, 'cases.txt');
writeFileSync(casesFile, rows.map(([name, tx, expect, prev]) => [name, tx, 0, expect, prev.join(',')].join('\t')).join('\n') + '\n');

if (!bin) {
  const target = process.env.CARGO_TARGET_DIR || join(tmpdir(), 'tacit-consensus-sats-target');
  const b = spawnSync('cargo', ['build', '--release', '--manifest-path', MANIFEST], { encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: target } });
  if (b.status !== 0) { console.log(`FAIL - the verifier did not build:\n${(b.stdout + b.stderr).trim().split('\n').slice(-15).join('\n')}`); process.exit(1); }
  bin = join(target, 'release/consensus-sats');
}
assert.ok(existsSync(bin), `the verifier is at ${bin}`);
const r = spawnSync(bin, [casesFile], { encoding: 'utf8' });
process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (r.status !== 0) { console.log('FAIL - a case did not come out as expected'); process.exit(1); }
console.log(`\n${rows.length}/${rows.length} consensus checks passed`);
process.exit(0);
