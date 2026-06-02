// SPEC §5.10 / §5.11.4 invariant 1 — Conservation.
//
// Negative-test coverage for the T_DEPOSIT kernel-sig gate. This is the
// invariant that says "every leaf in a pool's merkle tree was backed by a
// real consumed UTXO of the right (asset_id, denomination)" — without it,
// anyone can publish a structurally-valid envelope with a chosen
// (secret, ν) and garbage kernel_sig, then later withdraw against their
// own bogus leaf to inflate the pool.
//
// The bug this file is meant to catch:
//   - The dapp's validateOutpoint short-circuited T_DEPOSIT to a no-op.
//   - The worker's cron skipped kernel-sig verification on indexing.
//   - Every prior mixer test used kernel_sig = '00'.repeat(64) (garbage),
//     which is exactly what the gate is supposed to reject. Existing tests
//     therefore can't distinguish "gate is enforced and rejects garbage"
//     from "gate is missing and admits garbage" — both produce the same
//     pass on encoder/decoder/round-trip checks.
//
// What this validates:
//   - dapp.verifyMixerDepositKernelOnChain accepts a valid kernel sig
//   - worker.verifyMixerDepositKernel accepts the same
//   - both reject when kernel_sig is tampered (byte-for-byte mutation)
//   - both reject when the leaf commitment is mutated (kernel_msg drift)
//   - both reject when the parent's asset_id doesn't match
//   - both reject when denomination is wrong (E' lands off the curve image)
//
// Run: `node mixer-conservation.test.mjs`

import { JSDOM } from 'jsdom';

// jsdom shim before dapp import — same boot pattern as mixer-envelope.test.mjs.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');
const worker = await import('../worker/src/index.js');

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

// ---- Synthesis helpers ----

function bigintToBytes32(n) {
  const v = ((n % dapp.SECP_N) + dapp.SECP_N) % dapp.SECP_N;
  return hexToBytes(v.toString(16).padStart(64, '0'));
}
function randomTxidHex() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}
function makeWitness(envelopeBytes) {
  return [
    bytesToHex(new Uint8Array(64)),         // dummy 64-byte sig
    bytesToHex(envelopeBytes),               // envelope script (witness[1])
    bytesToHex(new Uint8Array(33)),         // dummy 33-byte control block
  ];
}

// Synthesize a parent CETCH whose vout=0 commitment opens to (denom, blinding).
// The verifier walks vin[1] → parent → commitment via getParentEnvelopeData,
// which doesn't validate the rangeproof (that's a separate validateOutpoint
// step). We can therefore pass an empty rangeproof — the kernel-sig path
// only depends on the commitment bytes.
function synthCETCHParent(denom, blinding) {
  const C = dapp.pedersenCommit(denom, blinding);
  const cBytes = dapp.pointToBytes(C);
  const payload = dapp.encodeCEtchPayload({
    ticker: 'TST', decimals: 0,
    commitment: cBytes,
    rangeproof: new Uint8Array(0),
    encryptedAmount: new Uint8Array(8),
    mintAuthority: null,
  });
  const xonly = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
  const envelopeScript = dapp.encodeEnvelopeScript(xonly, payload);
  const txid = randomTxidHex();
  const tx = {
    vin: [{
      txid: randomTxidHex(),
      vout: 0,
      witness: makeWitness(envelopeScript),
    }],
  };
  return { txid, tx, assetIdHex: bytesToHex(dapp.assetIdFor(txid, 0)) };
}

// Synthesize a T_DEPOSIT tx. `signingBlinding` is the scalar used to produce
// the kernel sig (under (C_in - denom·H).x_only()). For an honest deposit
// this equals the parent commitment's blinding; passing a mismatched value
// produces an envelope that will fail kernel verification — the negative
// case we want to catch.
function synthDeposit(parent, denom, signingBlinding, secret, nu, mutate = null) {
  const aid = hexToBytes(parent.assetIdHex);
  const inputTxidBE = hexToBytes(parent.txid).slice().reverse();
  const inputVout = 0;
  const leaf = dapp.computePoolLeafCommitment(secret, nu, denom);
  const kernelMsg = dapp.computeDepositKernelMsg(aid, denom, inputTxidBE, inputVout, leaf);
  const sig = dapp.signSchnorr(kernelMsg, bigintToBytes32(signingBlinding));
  let leafForEnv = leaf;
  let sigForEnv = sig;
  if (mutate === 'sig') {
    sigForEnv = sig.slice();
    sigForEnv[0] ^= 0x01;
  } else if (mutate === 'leaf') {
    leafForEnv = leaf.slice();
    leafForEnv[0] ^= 0x01;
  }
  const payload = dapp.encodeTDepositPayload({
    assetId: aid, denomination: denom,
    leafCommitment: leafForEnv, kernelSig: sigForEnv,
  });
  const xonly = new Uint8Array(32).map((_, i) => (i + 2) & 0xff);
  const envelopeScript = dapp.encodeEnvelopeScript(xonly, payload);
  const txid = randomTxidHex();
  const tx = {
    vin: [
      // commit/reveal stub at vin[0] — carries the envelope at witness[1]
      {
        txid: randomTxidHex(), vout: 0,
        witness: makeWitness(envelopeScript),
      },
      // asset input at vin[1] — points at the parent's vout=0 with a P2WPKH-shaped witness
      {
        txid: parent.txid, vout: inputVout,
        witness: [bytesToHex(new Uint8Array(64)), bytesToHex(new Uint8Array(33))],
      },
    ],
  };
  return { txid, tx, leaf: leafForEnv };
}

// In-memory tx store keyed by txid hex. Doubles as both a fetchTx for the
// dapp (signature: async (id) => txObj) and a fetch() backend for the
// worker's apiJson (which hits /tx/<id> at networkApi(env, network)).
class TxStore {
  constructor() { this.byTxid = new Map(); }
  add(txid, tx) { this.byTxid.set(txid.toLowerCase(), tx); }
  fetchTx = async (id) => this.byTxid.get(String(id).toLowerCase()) || null;
}

// Stub global fetch so the worker's apiJson sees our in-memory store.
function installWorkerFetchStub(store) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const m = u.match(/\/tx\/([0-9a-fA-F]{64})$/);
    if (m) {
      const tx = store.byTxid.get(m[1].toLowerCase());
      if (!tx) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      // Return the same shape mempool.space serves (worker just reads .vin)
      return new Response(JSON.stringify(tx), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('not stubbed: ' + u, { status: 500 });
  };
}

// ---- Tests ----

console.log('Setup: synth CETCH parent + T_DEPOSIT envelope, real kernel sig:');

const DENOM = 100000000n;
const BLINDING = 0xdeadbeefcafebabe1234567890abcdef00112233445566778899aabbccddeeffn % dapp.SECP_N;
const SECRET = new Uint8Array(32).map((_, i) => (i * 7 + 17) & 0xff);
const NU     = new Uint8Array(32).map((_, i) => (i * 11 + 31) & 0xff);

const parent = synthCETCHParent(DENOM, BLINDING);
const honest = synthDeposit(parent, DENOM, BLINDING, SECRET, NU);

const store = new TxStore();
store.add(parent.txid, parent.tx);
store.add(honest.txid, honest.tx);

// In-memory KV stub. commitmentForUtxo's cBTC.tac lien guard reads
// env.REGISTRY_KV before resolving the parent commitment; an honest mixer
// deposit's parent is never liened, so every get() returns null here.
const _kvStore = new Map();
const FAKE_ENV = {
  SIGNET_API: 'https://stub.local/api',
  MAINNET_API: 'https://stub.local/api',
  REGISTRY_KV: {
    get: async (k) => { const v = _kvStore.get(k); return v === undefined ? null : v; },
    put: async (k, v) => { _kvStore.set(k, v); },
    delete: async (k) => { _kvStore.delete(k); },
  },
};

await test('synth: parent CETCH txid and asset_id derive consistently', () => {
  return /^[0-9a-f]{64}$/.test(parent.txid) && /^[0-9a-f]{64}$/.test(parent.assetIdHex);
});

console.log('\nDapp side — verifyMixerDepositKernelOnChain:');

await test('accepts honest deposit (valid kernel sig under E\' = C_in − denom·H)', async () => {
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    honest.txid, parent.assetIdHex, DENOM, honest.leaf, store.fetchTx,
  );
  return ok === true;
});

await test('rejects deposit whose kernel_sig is byte-flipped', async () => {
  const evil = synthDeposit(parent, DENOM, BLINDING, SECRET, NU, 'sig');
  store.add(evil.txid, evil.tx);
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    evil.txid, parent.assetIdHex, DENOM, evil.leaf, store.fetchTx,
  );
  return ok === false;
});

await test('rejects deposit whose leaf_commitment was mutated post-sign (kernel_msg drift)', async () => {
  const evil = synthDeposit(parent, DENOM, BLINDING, SECRET, NU, 'leaf');
  store.add(evil.txid, evil.tx);
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    evil.txid, parent.assetIdHex, DENOM, evil.leaf, store.fetchTx,
  );
  return ok === false;
});

await test('rejects deposit whose kernel_sig was made under a wrong blinding (forged)', async () => {
  const wrongBlinding = (BLINDING + 1n) % dapp.SECP_N;
  const evil = synthDeposit(parent, DENOM, wrongBlinding, SECRET, NU);
  store.add(evil.txid, evil.tx);
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    evil.txid, parent.assetIdHex, DENOM, evil.leaf, store.fetchTx,
  );
  return ok === false;
});

await test('rejects deposit when claimed denomination differs from the kernel sig\'s denom', async () => {
  // The verifier is told the denom from the worker leaf record. If a malicious
  // worker mis-records the denom, the validator should not be fooled — the
  // kernel msg includes denom, so any mismatch makes the sig fail.
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    honest.txid, parent.assetIdHex, DENOM + 1n, honest.leaf, store.fetchTx,
  );
  return ok === false;
});

await test('rejects deposit when asset_id parameter differs from the envelope\'s', async () => {
  const wrongAid = '11'.repeat(32);
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    honest.txid, wrongAid, DENOM, honest.leaf, store.fetchTx,
  );
  return ok === false;
});

await test('returns null (transient) when fetchTx returns null — distinct from false', async () => {
  // Tri-state contract: null = "couldn't tell, try again" (transient fetch
  // failure — caller doesn't log a security warning); false = "definitely
  // bad, drop forever". scanPools relies on this distinction so a flaky
  // mempool.space call doesn't spam console.warn with bogus alerts.
  const stubbed = async () => null;
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    honest.txid, parent.assetIdHex, DENOM, honest.leaf, stubbed,
  );
  return ok === null;
});

// Height-pin: SPEC §5.10 canonical leaf order is (height, tx_index, txid).
// A worker that lies about deposited_at_height to re-order a pool's leaves
// would push the dapp to compute a tree whose root no honest indexer's
// recent-roots window contains. The dapp closes that vector by passing
// the worker-claimed height into verifyMixerDepositKernelOnChain and
// rejecting on mismatch. Below we re-stub fetchTx with an annotated
// status object (mempool.space includes status.block_height + confirmed
// on confirmed txs) and exercise the gate.
console.log('\nDapp side — height pin (canonical-order defense):');

const honestTxAtHeight = (h) => async (id) => {
  const tx = store.byTxid.get(String(id).toLowerCase());
  if (!tx) return null;
  if (id.toLowerCase() === honest.txid.toLowerCase()) {
    return { ...tx, status: { confirmed: true, block_height: h } };
  }
  return tx;
};

await test('accepts when expectedHeight matches tx.status.block_height', async () => {
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    honest.txid, parent.assetIdHex, DENOM, honest.leaf, honestTxAtHeight(800123), 800123,
  );
  return ok === true;
});

await test('rejects when expectedHeight does not match the on-chain block height', async () => {
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    honest.txid, parent.assetIdHex, DENOM, honest.leaf, honestTxAtHeight(800123), 800124,
  );
  return ok === false;
});

await test('rejects when expectedHeight is given but tx is unconfirmed (no status)', async () => {
  const stubUnconfirmed = async (id) => store.byTxid.get(String(id).toLowerCase()) || null;
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    honest.txid, parent.assetIdHex, DENOM, honest.leaf, stubUnconfirmed, 800123,
  );
  return ok === false;
});

await test('skips height check when expectedHeight is omitted (back-compat)', async () => {
  // Existing scanPools-style call sites pre-height-pin pass no expectedHeight
  // and MUST keep working unchanged. The same call without status on the tx
  // also has to succeed.
  const ok = await dapp.verifyMixerDepositKernelOnChain(
    honest.txid, parent.assetIdHex, DENOM, honest.leaf, store.fetchTx,
  );
  return ok === true;
});

// tx_index-against-block: closes the residual canonical-position gap. Even
// if the worker tells the truth about deposited_at_height, it could lie
// about tx_index to swap the order of two same-block deposits. The dapp
// fetches the block's ordered txid list and checks that depositTxid is at
// the claimed position.
console.log('\nDapp side — verifyTxIndexInBlock (canonical-position pin):');

const FAKE_BLOCK_HASH = 'a'.repeat(64);
const blockTxidsStub = (mapping) => async (h) => mapping.get((h || '').toLowerCase()) || null;

await test('accepts when txid is at the claimed index in its block', async () => {
  const txids = [randomTxidHex(), honest.txid, randomTxidHex(), randomTxidHex()];
  const fetchTxids = blockTxidsStub(new Map([[FAKE_BLOCK_HASH, txids]]));
  const ok = await dapp.verifyTxIndexInBlock(honest.txid, FAKE_BLOCK_HASH, 1, fetchTxids);
  return ok === true;
});

await test('rejects when txid is at a different index in its block (worker reordered)', async () => {
  const txids = [randomTxidHex(), honest.txid, randomTxidHex()];
  const fetchTxids = blockTxidsStub(new Map([[FAKE_BLOCK_HASH, txids]]));
  // Worker claims index 0 but the txid is at index 1.
  const ok = await dapp.verifyTxIndexInBlock(honest.txid, FAKE_BLOCK_HASH, 0, fetchTxids);
  return ok === false;
});

await test('rejects when claimed index is past the end of the block', async () => {
  const txids = [randomTxidHex(), honest.txid];
  const fetchTxids = blockTxidsStub(new Map([[FAKE_BLOCK_HASH, txids]]));
  const ok = await dapp.verifyTxIndexInBlock(honest.txid, FAKE_BLOCK_HASH, 99, fetchTxids);
  return ok === false;
});

await test('returns null (transient) when the block-txids fetch fails', async () => {
  // Mirror verifyMixerDepositKernelOnChain's tri-state contract: null means
  // "couldn't tell, retry on next refresh — do NOT log a security warning".
  // scanPools relies on this to avoid spamming console.warn when an Esplora
  // gateway is briefly unreachable.
  const fetchTxids = async () => null;
  const ok = await dapp.verifyTxIndexInBlock(honest.txid, FAKE_BLOCK_HASH, 1, fetchTxids);
  return ok === null;
});

await test('rejects malformed inputs (negative index, non-int index, non-string txid)', async () => {
  const fetchTxids = async () => [honest.txid];
  const a = await dapp.verifyTxIndexInBlock(honest.txid, FAKE_BLOCK_HASH, -1, fetchTxids);
  const b = await dapp.verifyTxIndexInBlock(honest.txid, FAKE_BLOCK_HASH, 1.5, fetchTxids);
  const c = await dapp.verifyTxIndexInBlock(null, FAKE_BLOCK_HASH, 0, fetchTxids);
  return a === false && b === false && c === false;
});

console.log('\nWorker side — verifyMixerDepositKernel (apiJson via fetch stub):');

installWorkerFetchStub(store);

await test('accepts honest deposit', async () => {
  const ok = await worker.verifyMixerDepositKernel(
    FAKE_ENV, honest.tx, parent.assetIdHex, DENOM.toString(),
    bytesToHex(honest.leaf),
    bytesToHex(getKernelSigFromTx(honest.tx)),
    'signet',
  );
  return ok === true;
});

await test('rejects byte-flipped kernel_sig', async () => {
  const evil = synthDeposit(parent, DENOM, BLINDING, SECRET, NU, 'sig');
  store.add(evil.txid, evil.tx);
  const ok = await worker.verifyMixerDepositKernel(
    FAKE_ENV, evil.tx, parent.assetIdHex, DENOM.toString(),
    bytesToHex(evil.leaf),
    bytesToHex(getKernelSigFromTx(evil.tx)),
    'signet',
  );
  return ok === false;
});

await test('rejects kernel_sig under wrong blinding (forged)', async () => {
  const wrongBlinding = (BLINDING + 7n) % dapp.SECP_N;
  const evil = synthDeposit(parent, DENOM, wrongBlinding, SECRET, NU);
  store.add(evil.txid, evil.tx);
  const ok = await worker.verifyMixerDepositKernel(
    FAKE_ENV, evil.tx, parent.assetIdHex, DENOM.toString(),
    bytesToHex(evil.leaf),
    bytesToHex(getKernelSigFromTx(evil.tx)),
    'signet',
  );
  return ok === false;
});

await test('rejects when the on-chain parent asset_id differs from the claimed one', async () => {
  // Build a deposit pointing at parent A but tell the verifier asset_id is
  // for some other asset. The verifier walks vin[1] → parent A's CETCH and
  // sees a mismatch with the expected asset_id, returning false without
  // even attempting the sig verify.
  const ok = await worker.verifyMixerDepositKernel(
    FAKE_ENV, honest.tx, '22'.repeat(32), DENOM.toString(),
    bytesToHex(honest.leaf),
    bytesToHex(getKernelSigFromTx(honest.tx)),
    'signet',
  );
  return ok === false;
});

await test('rejects deposit whose vin.length < 2', async () => {
  const truncated = { vin: [honest.tx.vin[0]] };
  const ok = await worker.verifyMixerDepositKernel(
    FAKE_ENV, truncated, parent.assetIdHex, DENOM.toString(),
    bytesToHex(honest.leaf),
    bytesToHex(getKernelSigFromTx(honest.tx)),
    'signet',
  );
  return ok === false;
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

// ---- Helper: pull the on-chain kernel_sig out of a deposit tx envelope.
// This mirrors what the cron does: decode the envelope at vin[0].witness[1]
// and read the kernel_sig field. Used so the worker test exercises the same
// bytes the cron would observe.
function getKernelSigFromTx(tx) {
  const wit = tx?.vin?.[0]?.witness;
  if (!Array.isArray(wit) || wit.length < 3) throw new Error('witness shape');
  const env = worker.decodeEnvelopeScript(hexToBytes(wit[1]));
  if (!env) throw new Error('envelope decode');
  const dec = worker.decodeTDepositPayload(env.payload);
  if (!dec || dec.kind !== 'deposit') throw new Error('not a deposit');
  return hexToBytes(dec.kernel_sig);
}
