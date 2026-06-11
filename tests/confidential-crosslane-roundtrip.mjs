#!/usr/bin/env node
// Cross-lane day-one round-trip — the full journey a tETH/TAC holder takes, modeled end-to-end in Node
// at the WITNESS level: bridge a confidential note IN (Bitcoin → Ethereum), spend it in a confidential
// transfer on Ethereum, then bridge the result back OUT (Ethereum → Bitcoin). bridge_mint is just
// buildBridgeBurn with destChain=ETHEREUM (one unified cross-out builder), and the minted note is
// byte-identical to a native one, so it spends like any other. This locks that the cross-lane ops
// COMPOSE — a bridged-in note is recoverable, spendable, and re-bridgeable-out — and that value is
// conserved across BOTH chain boundaries. The operational loop (the Bitcoin-side crossOut consumer +
// reflection prover) is out of scope here; this proves the assemblers chain and the value is preserved.
//
// Run: node tests/confidential-crosslane-roundtrip.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';
import { makeCrossoutConsumer } from '../dapp/confidential-crossout-consumer.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const deps = { secp, keccak256, sha256 };
const ct = makeConfidentialTransfer({ keccak256 });
const memo = makeConfidentialMemo({ secp, sha256, keccak256 });
const idx = makeConfidentialIndexer(deps);
const pool = makeConfidentialPool(deps);
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const pubHex = (priv) => '0x' + Buffer.from(G.multiply(priv).toRawBytes(true)).toString('hex');
// A two-sided day-one asset — the canonical mainnet TAC id (tETH behaves identically).
const ASSET = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const BITCOIN = 1, ETHEREUM = 2;            // destChain selectors (1=bitcoin, 2=ethereum)
const OWNER_ETH = '0x' + '00'.repeat(31) + 'e7';
const OWNER_BTC = '0x' + '00'.repeat(31) + 'b7';
const VALUE = 1500n;

// ── 1. Bridge IN (Bitcoin → Ethereum): burn VALUE on Bitcoin, destined for one Ethereum note ──
const btcInputs = [
  { value: 1000n, blinding: randomScalar(), secret: '0x' + '11'.repeat(32) },
  { value: 500n,  blinding: randomScalar(), secret: '0x' + '22'.repeat(32) },
];
const mintBlinding = randomScalar(), mintSecret = '0x' + 'c5'.repeat(32);
const c0 = pool.commitXY(btcInputs[0].value, btcInputs[0].blinding);
const inBind = pool.nullifier(c0.cx, c0.cy);
const bridgeIn = ct.buildBridgeBurn({
  inputs: btcInputs, outputs: [{ value: VALUE, blinding: mintBlinding, owner: OWNER_ETH }],
  assetId: ASSET, destChain: ETHEREUM, bindNullifier: inBind,
});
assert.ok(ct.verifyBridgeBurn(bridgeIn), 'bridge-in (Bitcoin burn → ETH mint) verifies');
const co = bridgeIn.crossOuts[0];
const ethLeaf = co.destCommitment;
assert.strictEqual(ethLeaf, pool.leaf(ASSET, co.cx, co.cy, OWNER_ETH), 'destCommitment is exactly the ETH leaf to mint');
assert.strictEqual(co.destChain, ETHEREUM, 'crossOut targets Ethereum');
ok('bridge IN: Bitcoin burns 1500 → one Ethereum leaf to mint (conserved, claimId-bound)');

// ── 2. Recover the minted note on Ethereum from chain + seed (byte-identical to native) ──
const rPriv = randomScalar(), rPub = pubHex(rPriv);
const mintedNote = { value: VALUE, blinding: mintBlinding, secret: mintSecret, asset: ASSET, owner: OWNER_ETH };
const sealed = memo.encodeMemo(memo.sealMemo(rPub, mintedNote, randomScalar));
const recovered = idx.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [ethLeaf], memos: [sealed] }], rPriv);
assert.strictEqual(recovered.length, 1, 'recipient recovers exactly the minted note');
assert.strictEqual(recovered[0].value, VALUE, 'minted note value recovered (1500, spendable)');
ok('the bridged-in note is recovered on Ethereum from chain + seed (spendable like any native note)');

// ── 3. Spend it on Ethereum: a confidential transfer (1500 → 1500, conserved) ──
const newBlinding = randomScalar();
const xfer = ct.buildTransfer({ inputs: [{ value: VALUE, blinding: mintBlinding }], outputs: [{ value: VALUE, blinding: newBlinding }] });
assert.ok(ct.verifyTransfer(xfer), 'the minted note spends in a confidential transfer (conserved)');
ok('the bridged-in note is spent on Ethereum in a confidential transfer (1500 conserved)');

// ── 4. Bridge OUT (Ethereum → Bitcoin): burn the transfer output back to a Bitcoin note ──
const outCommit = pool.commitXY(VALUE, newBlinding);
const outBind = pool.nullifier(outCommit.cx, outCommit.cy);
const bridgeOut = ct.buildBridgeBurn({
  inputs: [{ value: VALUE, blinding: newBlinding }],
  outputs: [{ value: VALUE, blinding: randomScalar(), owner: OWNER_BTC }],
  assetId: ASSET, destChain: BITCOIN, bindNullifier: outBind,
});
assert.ok(ct.verifyBridgeBurn(bridgeOut), 'bridge-out (ETH burn → Bitcoin mint) verifies');
assert.strictEqual(bridgeOut.crossOuts[0].destChain, BITCOIN, 'final crossOut targets Bitcoin');
ok('bridge OUT: the Ethereum note burns 1500 → one Bitcoin leaf to mint (conserved)');

// ── 5. Conservation across the WHOLE round-trip: each boundary verified, value is 1500 throughout ──
const btcIn = btcInputs.reduce((s, i) => s + i.value, 0n);
assert.strictEqual(btcIn, VALUE, 'Σ value burned on Bitcoin == 1500');
// Each leg verified above (bridge-in kernel, transfer kernel, bridge-out kernel), so by the chain of
// conservation the 1500 that entered on Bitcoin is exactly the 1500 minted back on Bitcoin — no leg
// can create or destroy value. The asset id is the same two-sided id at every leg.
assert.strictEqual(co.assetId.toLowerCase(), ASSET, 'bridge-in carries the asset id');
assert.strictEqual(bridgeOut.crossOuts[0].assetId.toLowerCase(), ASSET, 'bridge-out carries the same asset id');
ok('round-trip conserves: 1500 in on Bitcoin → ETH note → spent → 1500 out on Bitcoin (same asset, no value created)');

// ── 6. Worker leg: the bridge-out crossOut is read + bound by the CrossOut consumer (the ETH→Bitcoin mint) ──
// Proves the witness crossOut format actually feeds the worker consumer: model the on-chain
// CrossOutRecorded log from `bridgeOut`, scan it (records past finality), then bind the Bitcoin output.
{
  const evmLog = makeConfidentialEvmLog({ keccak256 });
  const u256 = (v) => BigInt(v).toString(16).padStart(64, '0');
  const strip = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
  const co2 = bridgeOut.crossOuts[0];
  const log = {
    topics: [evmLog.TOPIC0.CrossOutRecorded, co2.claimId],
    data: '0x' + u256(co2.destChain) + strip(co2.destCommitment) + strip(co2.nullifier) + strip(co2.assetId),
    blockNumber: 500,
  };
  const kv = new Map();
  const consumer = makeCrossoutConsumer({
    ethGetLogs: async () => [log], kvGet: async (k) => (kv.has(k) ? kv.get(k) : null),
    kvPut: async (k, v) => { kv.set(k, v); }, evmLog, confirmations: 36,
  });
  const scanned = await consumer.scan({ network: 'mainnet', pool: '0xpool', tipHeight: 600, fromBlock: 0 });
  assert.strictEqual(scanned.recorded, 1, 'the consumer records the bridge-out crossOut');
  const bound = await consumer.bindBitcoinOutput({ network: 'mainnet', claimId: co2.claimId, outputLeaf: co2.destCommitment });
  assert.strictEqual(bound.bound, true, 'the consumer binds the Bitcoin output to the recorded crossOut (mint authorized)');
  assert.strictEqual(bound.record.assetId.toLowerCase(), ASSET, 'the minted Bitcoin note carries the same asset id');
  const replay = await consumer.bindBitcoinOutput({ network: 'mainnet', claimId: co2.claimId, outputLeaf: co2.destCommitment });
  assert.strictEqual(replay.rejected, 'already-consumed', 'a second mint of the same crossOut is rejected (one-mint-per-claimId)');
  ok('worker leg: the bridge-out crossOut is read + bound by the consumer (ETH→Bitcoin mint authorized once, claimId-gated)');
}

console.log(`\n${n}/6 cross-lane round-trip checks passed`);
