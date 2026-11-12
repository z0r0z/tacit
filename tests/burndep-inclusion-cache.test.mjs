// worker/src/burndep-admission.js keeps each provenance transaction's place in its block (assembler.inclusionOf's fields and
// the block's own bytes for it) once it has read the block, so a deep history's hops are read from the explorers once, not
// for every check and every batch that carries the deposit. What it builds from a kept proof must be the blob it builds from
// the whole block, byte for byte, and bytes that differ from the block's outside the txid are made the block's.
import { test } from 'node:test';
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeBurndepAdmission } from '../worker/src/burndep-admission.js';
import { makeBurnDepositKit } from '../dapp/burn-deposit-bitcoin.js';
import { buildRevealTx, makeCoinbaseForEnvTx, computeTxid, computeMerkleRoot, mineHeader, dsha256, cat, varint } from './btc-mini.mjs';

const kit = makeBurnDepositKit({ secp, keccak256: keccak_256, sha256 });
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

// Three protocol transactions, each in its own block after a coinbase that commits to its wtxid.
const blocks = new Map(); // block hash (display) -> raw bytes
const made = [0x31, 0x32, 0x33].map((tag) => {
  const tx = buildRevealTx(Buffer.from([tag, ...Buffer.alloc(40, tag)]));
  Buffer.alloc(32, tag).copy(tx, 7); // its own prevout, so each has its own txid (the payload is witness only)
  const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
  const coinbase = Buffer.from(coinbaseSpec.txData.slice(2), 'hex');
  const header = mineHeader(computeMerkleRoot([cbTxid, computeTxid(tx)]));
  const hash = Buffer.from(dsha256(header)).reverse().toString('hex');
  blocks.set(hash, cat([header, varint(2), coinbase, tx]));
  return { tx, hash, coinbase, cbTxid };
});
const C = (b) => '0x' + b + 'aa'.repeat(32);
const bundleOf = (txs = made.map((m) => m.tx)) => ({
  etch: { tx: hex(txs[0]), blockHash: made[0].hash },
  cxfers: [1, 2].map((i) => ({
    tx: hex(txs[i]), blockHash: made[i].hash, inputs: [{ prevTxid: hex(computeTxid(txs[i - 1])), prevVout: 0, commitment: C('02') }],
    outputs: [{ vout: 0, commitment: C('03') }], burnedAmount: 0, inputSkip: 0,
  })),
});
function admissionOver(kv) {
  const reads = [];
  const admission = makeBurndepAdmission({
    env: kv ? { REGISTRY_KV: kv } : {}, network: 'mainnet', kit, deps: { sha256 },
    api: async (env, path) => { throw new Error(`unexpected ${path}`); },
    apiRawBytes: async (env, path) => {
      const h = /^\/block\/([0-9a-f]{64})\/raw$/.exec(path)[1];
      reads.push(h);
      return blocks.get(h);
    },
  });
  return { admission, reads };
}
const memKv = () => { const m = new Map(), ttl = new Map(); return { _m: m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v, o) => { m.set(k, v); ttl.set(k, o?.expirationTtl); }, _ttl: ttl }; };
const blobOf = (b) => hex(kit.assembler.serializeProvenanceBlob(kit.assembler.buildBurnDepositStatic({ etch: b.etch, provHeaders: [], cxfers: b.cxfers, cmints: [] })));

test('blocks are read once: a second check over the same store reads none, and both build the same blob', async () => {
  const kv = memKv();
  const a = admissionOver(kv);
  const blobA = blobOf(await a.admission.enrichBurnDeposit(bundleOf()));
  assert.equal(a.reads.length, 3);
  assert.equal([...kv._m.keys()].filter((k) => k.startsWith('burndepwit:mainnet:')).length, 3);
  const b = admissionOver(kv);
  const blobB = blobOf(await b.admission.enrichBurnDeposit(bundleOf()));
  assert.equal(b.reads.length, 0, 'read a block again');
  assert.equal(blobB, blobA);
});

test('the proofs kept expire, since the block they came from can be read again', async () => {
  const kv = memKv();
  await admissionOver(kv).admission.enrichBurnDeposit(bundleOf());
  const ttls = [...kv._ttl.values()];
  assert.ok(ttls.length > 0 && ttls.every((t) => t >= 30 * 86400 && t <= 400 * 86400), `every kept proof has a lifetime (${ttls.join(',')})`);
});

test('the blob from kept proofs is the blob from the whole blocks, byte for byte', async () => {
  const fromKept = blobOf(await admissionOver(memKv()).admission.enrichBurnDeposit(bundleOf()));
  const whole = (i, rec) => ({
    ...rec, blockTxids: [made[i].cbTxid, computeTxid(made[i].tx)].map((t) => Uint8Array.from(t)),
    blockWtxids: [made[i].coinbase, made[i].tx].map((t) => Uint8Array.from(dsha256(t))), coinbase: hex(made[i].coinbase), index: 1,
  });
  const b = bundleOf();
  assert.equal(fromKept, blobOf({ etch: whole(0, b.etch), cxfers: b.cxfers.map((c, i) => whole(i + 1, c)) }));
});

test('bytes that differ from the block only in their witness come back as the block\'s', async () => {
  const altered = made.map((m) => Buffer.from(m.tx));
  altered[1][altered[1].length - 40] ^= 0xff; // inside the witness: the txid is unchanged
  assert.equal(hex(computeTxid(altered[1])), hex(computeTxid(made[1].tx)));
  const out = await admissionOver(memKv()).admission.enrichBurnDeposit(bundleOf(altered));
  assert.equal(out.cxfers[0].tx, hex(made[1].tx));
});

test('a transaction its block does not hold is refused, and nothing is kept for it', async () => {
  const kv = memKv();
  const b = bundleOf();
  b.cxfers[1].blockHash = made[1].hash; // the third transaction, pointed at the second's block
  await assert.rejects(admissionOver(kv).admission.enrichBurnDeposit(b), /absent from block/);
  assert.ok(![...kv._m.keys()].some((k) => k.endsWith(Buffer.from(computeTxid(made[2].tx)).toString('hex'))));
});
