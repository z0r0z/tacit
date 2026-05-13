// Indexer state machine tests.
//
// This is the test suite that exercises the recursive ancestry walker against
// synthesised Bitcoin txs — the actual validation flow that decides whether a
// UTXO counts toward a balance or gets flagged as inflated.
//
// Coverage:
//   - Valid chains: CETCH → CXFER, CETCH → CXFER → CXFER (deep), CETCH → MINT, CETCH → CXFER → BURN
//   - Memoization: shared ancestors validated once
//   - Asset_id consistency across mixed-opcode parents (CETCH/MINT/CXFER/BURN)
//   - Mixed-asset rejection (CXFER spends inputs from two different assets)
//   - Forged kernel sig rejection deep in chain
//   - Forged rangeproof rejection deep in chain
//   - CETCH at vout != 0 → reject
//   - MINT against non-mintable CETCH → reject
//   - MINT with wrong issuer sig → reject
//   - BURN with N=0 (full burn) → kernel sig verifies
//   - BURN-then-spend chain: child of BURN can be spent
//   - Depth-bound enforcement (chain longer than 200)
//   - Missing envelope → reject
//   - rpBatch path defers rangeproofs and a single batch verify clears them
//
// Run: `node indexer.test.mjs`
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes, bytesToPoint, bigintToBytes32,
  randomScalar, _bpGens,
  bpRangeAggProve, bpRangeAggBatchVerify,
} from './bulletproofs.mjs';
import {
  T_CETCH, T_CXFER, T_MINT, T_BURN,
  reverseBytes, assetIdFor,
  encodeCEtchPayload, encodeCXferPayload, encodeCMintPayload, encodeCBurnPayload,
  computeKernelMsg, computeMintMsg,
  signSchnorr, verifySchnorr,
} from './composition.mjs';
import {
  encodeEnvelopeScript, decodeEnvelopeScript,
  validateOutpoint,
} from './indexer.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  const start = Date.now();
  return Promise.resolve(fn()).then(ok => {
    const ms = Date.now() - start;
    if (ok) { console.log(`  PASS  ${label.padEnd(60)} ${ms}ms`); pass++; }
    else    { console.log(`  FAIL  ${label.padEnd(60)} ${ms}ms`); fail++; }
  }).catch(e => {
    console.log(`  THROW ${label.padEnd(60)} ${e.message}`);
    fail++;
  });
}

console.log('Warming up generators…');
const t0 = Date.now();
_bpGens();
console.log(`  ready in ${Date.now() - t0}ms\n`);

// --- Synthetic tx builder ---
// We don't need real Bitcoin txids — just stable unique hex strings the
// validator can use to look up parents. assetIdFor() depends on the txid
// being deterministic, so we use a counter-based scheme that yields valid
// 64-char lowercase hex.
let _txidCounter = 0;
function nextTxid() {
  _txidCounter++;
  const buf = new Uint8Array(32);
  new DataView(buf.buffer).setUint32(28, _txidCounter, false); // big-endian counter in last 4 bytes
  return bytesToHex(buf);
}
const fakeXonly = () => crypto.getRandomValues(new Uint8Array(32));
const fakeWitnessSig = () => bytesToHex(new Uint8Array(64));   // 64 zero bytes
const fakeControlBlock = () => bytesToHex(new Uint8Array(33)); // 33 zero bytes

class TxStore {
  constructor() { this.map = new Map(); }
  add(txid, tx) { this.map.set(txid, tx); return txid; }
  fetch = async (txid) => this.map.get(txid) || null;
}

// Build a tx with envelope at vin[0].witness[1]; remaining inputs are
// arbitrary-witness P2WPKH spending parent UTXOs we synthesised.
//
// `commitTxRef`: optional { txid, vout } that overrides vin[0]'s outpoint —
// needed for T_MINT validation, which fetches that outpoint's tx and reads
// its vin[0] to derive commit_anchor (SPEC §5.3). Defaults to a random
// outpoint when not provided (CETCH/CXFER/BURN don't fetch commit-tx).
function makeEnvelopeTx(envelopeBytes, assetInputs = [], commitTxRef = null) {
  const vin = [{
    txid: commitTxRef?.txid ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    vout: commitTxRef?.vout ?? 0,
    witness: [fakeWitnessSig(), bytesToHex(envelopeBytes), fakeControlBlock()],
  }];
  for (const inp of assetInputs) {
    vin.push({
      txid: inp.txid, vout: inp.vout,
      witness: [fakeWitnessSig(), bytesToHex(new Uint8Array(33))], // P2WPKH (sig, pubkey)
    });
  }
  return { vin };
}

// Register a fake "commit tx" in the store and return both its txid and the
// 36-byte commit_anchor an issuer would sign. The commit tx's vin[0] outpoint
// is whatever the caller passes (or a fresh random outpoint by default) — that
// outpoint becomes the anchor. The mint reveal's vin[0].txid then points at
// this commit-stub txid so validateOutpoint's `fetchTx` lookup resolves.
function synthCommitStub(store, fundingOutpoint = null) {
  const op = fundingOutpoint || {
    txid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    vout: Math.floor(Math.random() * 4),
  };
  const commitTxid = nextTxid();
  store.add(commitTxid, {
    vin: [{ txid: op.txid, vout: op.vout, witness: [fakeWitnessSig(), bytesToHex(new Uint8Array(33))] }],
  });
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, op.vout >>> 0, true);
  const anchor = new Uint8Array(36);
  anchor.set(hexToBytes(op.txid).reverse(), 0); // txid_BE_reversed
  anchor.set(voutLE, 32);
  return { commitTxid, fundingOutpoint: op, anchor };
}

// ---- Synthesize CETCH ----
function synthCETCH(store, { ticker = 'TST', decimals = 0, supply = 1000n, blinding, mintAuthority = null } = {}) {
  const r = blinding ?? randomScalar();
  const { proof, commitments } = bpRangeAggProve([supply], [r]);
  const commitment = pointToBytes(commitments[0]);
  const payload = encodeCEtchPayload({
    ticker, decimals, commitment,
    rangeproof: proof,
    encryptedAmount: new Uint8Array(8),
    mintAuthority: mintAuthority || null,
  });
  const envelope = encodeEnvelopeScript(fakeXonly(), payload);
  const tx = makeEnvelopeTx(envelope);
  const txid = nextTxid();
  store.add(txid, tx);
  return {
    txid, vout: 0,
    assetIdHex: bytesToHex(assetIdFor(txid, 0)),
    amount: supply, blinding: r, commitment,
  };
}

// ---- Synthesize CXFER ----
// inputs: [{ txid, vout, amount, blinding, commitment? }]
// outputs: [{ amount, blinding }]  (recipient first, then change, etc.)
function synthCXFER(store, { assetIdHex, inputs, outputs }) {
  const values = outputs.map(o => o.amount);
  const blinds = outputs.map(o => o.blinding);
  const { proof, commitments } = bpRangeAggProve(values, blinds);
  const outCommitBytes = commitments.map(pointToBytes);
  // Kernel sig: excess = Σ r_out − Σ r_in (mod N)
  const sumOut = blinds.reduce((s, x) => modN(s + x), 0n);
  const sumIn = inputs.reduce((s, x) => modN(s + x.blinding), 0n);
  const excess = modN(sumOut - sumIn);
  const inputOps = inputs.map(i => ({ txid: i.txid, vout: i.vout }));
  const aidBytes = hexToBytes(assetIdHex);
  const msg = computeKernelMsg(aidBytes, inputOps, outCommitBytes);
  const sig = signSchnorr(msg, bigintToBytes32(excess));
  const payload = encodeCXferPayload({
    assetId: aidBytes, kernelSig: sig,
    outputs: outputs.map((o, i) => ({
      commitment: outCommitBytes[i],
      encryptedAmount: new Uint8Array(8),
    })),
    rangeproof: proof,
  });
  const envelope = encodeEnvelopeScript(fakeXonly(), payload);
  const tx = makeEnvelopeTx(envelope, inputs);
  const txid = nextTxid();
  store.add(txid, tx);
  return {
    txid, tx, assetIdHex,
    outs: outputs.map((o, i) => ({
      txid, vout: i,
      amount: o.amount, blinding: o.blinding,
      commitment: outCommitBytes[i],
    })),
  };
}

// ---- Synthesize CMINT ----
// Includes a commit-stub tx so the validator's anchor lookup (SPEC §5.3)
// resolves. The mint reveal's vin[0].txid points at the commit stub.
function synthMINT(store, { assetIdHex, etchTxid, amount, blinding, mintAuthorityPriv, fundingOutpoint = null }) {
  const { proof, commitments } = bpRangeAggProve([amount], [blinding]);
  const commitment = pointToBytes(commitments[0]);
  const ct = new Uint8Array(8);
  const aidBytes = hexToBytes(assetIdHex);
  const etchTxidBytes = hexToBytes(etchTxid);
  const stub = synthCommitStub(store, fundingOutpoint);
  const mintMsg = computeMintMsg(aidBytes, stub.anchor, commitment, ct);
  const issuerSig = signSchnorr(mintMsg, mintAuthorityPriv);
  const payload = encodeCMintPayload({
    assetId: aidBytes, etchTxid: etchTxidBytes,
    commitment, encryptedAmount: ct,
    rangeproof: proof, issuerSig,
  });
  const envelope = encodeEnvelopeScript(fakeXonly(), payload);
  const tx = makeEnvelopeTx(envelope, [], { txid: stub.commitTxid, vout: 0 });
  const txid = nextTxid();
  store.add(txid, tx);
  return { txid, vout: 0, assetIdHex, amount, blinding, commitment, anchor: stub.anchor };
}

// ---- Synthesize CBURN ----
function synthBURN(store, { assetIdHex, inputs, outputs, burnedAmount }) {
  let proof = new Uint8Array(0);
  let outCommitBytes = [];
  if (outputs.length > 0) {
    const values = outputs.map(o => o.amount);
    const blinds = outputs.map(o => o.blinding);
    const built = bpRangeAggProve(values, blinds);
    proof = built.proof;
    outCommitBytes = built.commitments.map(pointToBytes);
  }
  const sumOut = outputs.reduce((s, o) => modN(s + o.blinding), 0n);
  const sumIn = inputs.reduce((s, x) => modN(s + x.blinding), 0n);
  const excess = modN(sumOut - sumIn);
  const inputOps = inputs.map(i => ({ txid: i.txid, vout: i.vout }));
  const aidBytes = hexToBytes(assetIdHex);
  const msg = computeKernelMsg(aidBytes, inputOps, outCommitBytes, burnedAmount);
  const sig = signSchnorr(msg, bigintToBytes32(excess));
  const payload = encodeCBurnPayload({
    assetId: aidBytes, burnedAmount, kernelSig: sig,
    outputs: outputs.map((o, i) => ({
      commitment: outCommitBytes[i],
      encryptedAmount: new Uint8Array(8),
    })),
    rangeproof: proof,
  });
  const envelope = encodeEnvelopeScript(fakeXonly(), payload);
  const tx = makeEnvelopeTx(envelope, inputs);
  const txid = nextTxid();
  store.add(txid, tx);
  return {
    txid, tx, assetIdHex,
    outs: outputs.map((o, i) => ({
      txid, vout: i,
      amount: o.amount, blinding: o.blinding,
      commitment: outCommitBytes[i],
    })),
  };
}

// ============== TESTS ==============

console.log('Valid chains:');

await test('CETCH alone validates (vout=0)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, {});
  const set = new Map();
  return await validateOutpoint(etch.txid, 0, set, store.fetch);
});

await test('CETCH at vout=1 rejects (only vout 0 holds the supply)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, {});
  const set = new Map();
  return !(await validateOutpoint(etch.txid, 1, set, store.fetch));
});

await test('CETCH → CXFER (1 hop, balanced)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const r1 = randomScalar(), r2 = randomScalar();
  const xfer = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [
      { amount: 300n, blinding: r1 },
      { amount: 700n, blinding: r2 },
    ],
  });
  const set = new Map();
  return await validateOutpoint(xfer.txid, 0, set, store.fetch);
});

await test('CETCH → CXFER → CXFER (deep chain, all valid)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x1 = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [
      { amount: 300n, blinding: randomScalar() },
      { amount: 700n, blinding: randomScalar() },
    ],
  });
  // Spend the 700-change UTXO
  const x2 = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: x1.txid, vout: 1, amount: 700n, blinding: x1.outs[1].blinding }],
    outputs: [
      { amount: 200n, blinding: randomScalar() },
      { amount: 500n, blinding: randomScalar() },
    ],
  });
  const set = new Map();
  return await validateOutpoint(x2.txid, 0, set, store.fetch);
});

await test('CETCH → MINT (mintable)', async () => {
  const store = new TxStore();
  const mintPriv = secp.utils.randomPrivateKey();
  const mintAuthority = secp.getPublicKey(mintPriv, true).slice(1); // x-only
  const etch = synthCETCH(store, { supply: 1000n, mintAuthority });
  const mint = synthMINT(store, {
    assetIdHex: etch.assetIdHex,
    etchTxid: etch.txid,
    amount: 500n, blinding: randomScalar(),
    mintAuthorityPriv: mintPriv,
  });
  const set = new Map();
  return await validateOutpoint(mint.txid, 0, set, store.fetch);
});

await test('CETCH → MINT → CXFER (spend minted supply)', async () => {
  const store = new TxStore();
  const mintPriv = secp.utils.randomPrivateKey();
  const mintAuthority = secp.getPublicKey(mintPriv, true).slice(1);
  const etch = synthCETCH(store, { supply: 1000n, mintAuthority });
  const mint = synthMINT(store, {
    assetIdHex: etch.assetIdHex,
    etchTxid: etch.txid,
    amount: 500n, blinding: randomScalar(),
    mintAuthorityPriv: mintPriv,
  });
  // Spend the mint output
  const xfer = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: mint.txid, vout: 0, amount: 500n, blinding: mint.blinding }],
    outputs: [
      { amount: 100n, blinding: randomScalar() },
      { amount: 400n, blinding: randomScalar() },
    ],
  });
  const set = new Map();
  return await validateOutpoint(xfer.txid, 0, set, store.fetch);
});

await test('CETCH → CXFER → BURN (full burn, no change)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x1 = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [
      { amount: 300n, blinding: randomScalar() },
      { amount: 700n, blinding: randomScalar() },
    ],
  });
  // Burn the entire 300 from vout 0
  const burn = synthBURN(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: x1.txid, vout: 0, amount: 300n, blinding: x1.outs[0].blinding }],
    outputs: [],
    burnedAmount: 300n,
  });
  // Burn tx itself: there's no UTXO at burn.txid:0 since N=0. Validate via spending
  // it as input (won't work since burn has no outputs to spend) — instead, validate
  // by querying the burn tx directly. We need to validate "is the burn tx itself sound".
  // The way to check: walk an outpoint pointing INTO the burn — but burn has no outputs.
  // So we test the burn by validating its own kernel: validateOutpoint(burn.txid, 0)
  // Since N=0, no output outpoint exists; validator returns false on vout >= N when N>0.
  // For N=0 the check is `if (isBurn && N > 0 && vout >= N)` — N=0 lets vout=0 pass.
  // The validator runs the full check (kernel sig + asset_id), then markAll(max(N,1)=1).
  const set = new Map();
  return await validateOutpoint(burn.txid, 0, set, store.fetch);
});

await test('CBURN with change (partial burn)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x1 = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [
      { amount: 1000n, blinding: randomScalar() },
    ],
  });
  // Burn 700, keep 300 as change
  const burn = synthBURN(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: x1.txid, vout: 0, amount: 1000n, blinding: x1.outs[0].blinding }],
    outputs: [{ amount: 300n, blinding: randomScalar() }],
    burnedAmount: 700n,
  });
  const set = new Map();
  return await validateOutpoint(burn.txid, 0, set, store.fetch);
});

await test('CBURN-with-change → CXFER (children of burn are spendable)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x1 = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  const burn = synthBURN(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: x1.txid, vout: 0, amount: 1000n, blinding: x1.outs[0].blinding }],
    outputs: [{ amount: 300n, blinding: randomScalar() }],
    burnedAmount: 700n,
  });
  const xfer = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: burn.txid, vout: 0, amount: 300n, blinding: burn.outs[0].blinding }],
    outputs: [
      { amount: 100n, blinding: randomScalar() },
      { amount: 200n, blinding: randomScalar() },
    ],
  });
  const set = new Map();
  return await validateOutpoint(xfer.txid, 0, set, store.fetch);
});

console.log('\nAdversarial chains:');

await test('CXFER spending CETCH at vout=1 (no such commitment) REJECTS', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  // Try to spend etch.txid:1 — getParentEnvelopeData returns null for CETCH vout != 0
  const x = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 1, amount: 1000n, blinding: etch.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  const set = new Map();
  return !(await validateOutpoint(x.txid, 0, set, store.fetch));
});

await test('CXFER claiming wrong asset_id REJECTS', async () => {
  const store = new TxStore();
  const etchA = synthCETCH(store, { supply: 1000n });
  const etchB = synthCETCH(store, { supply: 1000n });
  // Spend etchA's UTXO but claim asset_id of etchB
  const x = synthCXFER(store, {
    assetIdHex: etchB.assetIdHex,                              // <-- wrong asset_id
    inputs: [{ txid: etchA.txid, vout: 0, amount: 1000n, blinding: etchA.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  const set = new Map();
  return !(await validateOutpoint(x.txid, 0, set, store.fetch));
});

await test('CXFER with mixed-asset inputs REJECTS', async () => {
  const store = new TxStore();
  const etchA = synthCETCH(store, { supply: 500n });
  const etchB = synthCETCH(store, { supply: 500n });
  // Try to claim asset_id=A but spend an input from B
  const x = synthCXFER(store, {
    assetIdHex: etchA.assetIdHex,
    inputs: [
      { txid: etchA.txid, vout: 0, amount: 500n, blinding: etchA.blinding },
      { txid: etchB.txid, vout: 0, amount: 500n, blinding: etchB.blinding }, // wrong asset
    ],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  const set = new Map();
  return !(await validateOutpoint(x.txid, 0, set, store.fetch));
});

await test('CXFER with unbalanced amounts (inflation) REJECTS', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 100n });
  // Try to mint 900 from nothing: input=100, outputs=1000
  const x = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 100n, blinding: etch.blinding }],
    outputs: [
      { amount: 700n, blinding: randomScalar() },
      { amount: 300n, blinding: randomScalar() },
    ],
  });
  const set = new Map();
  return !(await validateOutpoint(x.txid, 0, set, store.fetch));
});

await test('CXFER → CXFER with bad kernel sig 1 hop down REJECTS', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  // Build x1 with intentionally-corrupted sig
  const r1 = randomScalar(), r2 = randomScalar();
  const { proof, commitments } = bpRangeAggProve([300n, 700n], [r1, r2]);
  const outCommits = commitments.map(pointToBytes);
  const aidBytes = hexToBytes(etch.assetIdHex);
  const inputOps = [{ txid: etch.txid, vout: 0 }];
  const correctMsg = computeKernelMsg(aidBytes, inputOps, outCommits);
  // Sign with WRONG priv (random instead of excess)
  const wrongSig = signSchnorr(correctMsg, secp.utils.randomPrivateKey());
  const payload = encodeCXferPayload({
    assetId: aidBytes, kernelSig: wrongSig,
    outputs: [
      { commitment: outCommits[0], encryptedAmount: new Uint8Array(8) },
      { commitment: outCommits[1], encryptedAmount: new Uint8Array(8) },
    ],
    rangeproof: proof,
  });
  const env = encodeEnvelopeScript(fakeXonly(), payload);
  const tx = makeEnvelopeTx(env, [{ txid: etch.txid, vout: 0 }]);
  const txid = nextTxid();
  store.add(txid, tx);
  const set = new Map();
  return !(await validateOutpoint(txid, 0, set, store.fetch));
});

await test('CXFER with tampered rangeproof REJECTS', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  // Tamper one byte in the envelope script — this corrupts the rangeproof
  // (or some other field; either way must reject).
  const tx = await store.fetch(x.txid);
  const envHex = tx.vin[0].witness[1];
  const envBytes = new Uint8Array(hexToBytes(envHex));
  envBytes[200] ^= 1;  // pick a byte deep inside the rangeproof region
  tx.vin[0].witness[1] = bytesToHex(envBytes);
  const set = new Map();
  return !(await validateOutpoint(x.txid, 0, set, store.fetch));
});

await test('Bad rangeproof in middle of chain (3-hop) REJECTS the leaf', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x1 = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  // Tamper x1's rangeproof so x1 is bad, then build a "valid"-looking x2 that spends x1
  const x1tx = await store.fetch(x1.txid);
  const envBytes = new Uint8Array(hexToBytes(x1tx.vin[0].witness[1]));
  envBytes[150] ^= 1;
  x1tx.vin[0].witness[1] = bytesToHex(envBytes);
  // Build x2 spending x1 (the tamper above corrupts the BP, but x2's build is unaware).
  // Note: x2 references x1.outs[0] via amount/blinding — those still match what x2's
  // synthesizer thinks. The validator catches the bad rangeproof one hop up.
  const x2 = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: x1.txid, vout: 0, amount: 1000n, blinding: x1.outs[0].blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  const set = new Map();
  return !(await validateOutpoint(x2.txid, 0, set, store.fetch));
});

await test('MINT against non-mintable CETCH REJECTS', async () => {
  const store = new TxStore();
  const mintPriv = secp.utils.randomPrivateKey();
  // Etch with no mint authority → all-zero, non-mintable
  const etch = synthCETCH(store, { supply: 1000n });  // mintAuthority defaults to null/zero
  const mint = synthMINT(store, {
    assetIdHex: etch.assetIdHex,
    etchTxid: etch.txid,
    amount: 500n, blinding: randomScalar(),
    mintAuthorityPriv: mintPriv,
  });
  const set = new Map();
  return !(await validateOutpoint(mint.txid, 0, set, store.fetch));
});

await test('MINT signed by wrong key REJECTS', async () => {
  const store = new TxStore();
  const realMintPriv = secp.utils.randomPrivateKey();
  const realMintAuth = secp.getPublicKey(realMintPriv, true).slice(1);
  const wrongPriv = secp.utils.randomPrivateKey();
  const etch = synthCETCH(store, { supply: 1000n, mintAuthority: realMintAuth });
  const mint = synthMINT(store, {
    assetIdHex: etch.assetIdHex,
    etchTxid: etch.txid,
    amount: 500n, blinding: randomScalar(),
    mintAuthorityPriv: wrongPriv,                      // <-- wrong signer
  });
  const set = new Map();
  return !(await validateOutpoint(mint.txid, 0, set, store.fetch));
});

await test('MINT claiming wrong etch_txid REJECTS (asset_id mismatch)', async () => {
  const store = new TxStore();
  const mintPriv = secp.utils.randomPrivateKey();
  const mintAuth = secp.getPublicKey(mintPriv, true).slice(1);
  const etchA = synthCETCH(store, { supply: 1000n, mintAuthority: mintAuth });
  const etchB = synthCETCH(store, { supply: 1000n });
  // Build a CMINT claiming asset_id of A but pointing to etch_txid of B
  const ct = new Uint8Array(8);
  const aidBytes = hexToBytes(etchA.assetIdHex);
  const r = randomScalar();
  const { proof, commitments } = bpRangeAggProve([500n], [r]);
  const commitment = pointToBytes(commitments[0]);
  const stub = synthCommitStub(store);
  const mintMsg = computeMintMsg(aidBytes, stub.anchor, commitment, ct);
  const issuerSig = signSchnorr(mintMsg, mintPriv);
  const payload = encodeCMintPayload({
    assetId: aidBytes, etchTxid: hexToBytes(etchB.txid),  // <-- wrong etch_txid
    commitment, encryptedAmount: ct,
    rangeproof: proof, issuerSig,
  });
  const env = encodeEnvelopeScript(fakeXonly(), payload);
  const tx = makeEnvelopeTx(env, [], { txid: stub.commitTxid, vout: 0 });
  const txid = nextTxid();
  store.add(txid, tx);
  const set = new Map();
  return !(await validateOutpoint(txid, 0, set, store.fetch));
});

await test('MINT envelope replay into different commit/reveal pair REJECTS (SPEC §5.3 anchor binding)', async () => {
  // The attacker reads an honest issuer's on-chain T_MINT envelope and rewraps
  // its bytes (asset_id, commitment, ct, rangeproof, issuer_sig) into a fresh
  // commit/reveal pair at the attacker's own address. The validator must
  // reject because the new commit_anchor differs from what the issuer signed.
  const store = new TxStore();
  const mintPriv = secp.utils.randomPrivateKey();
  const mintAuth = secp.getPublicKey(mintPriv, true).slice(1);
  const etch = synthCETCH(store, { supply: 1000n, mintAuthority: mintAuth });

  // Honest mint: issuer signs with anchor derived from their own commit-stub.
  const honestMint = synthMINT(store, {
    assetIdHex: etch.assetIdHex,
    etchTxid: etch.txid,
    amount: 500n, blinding: randomScalar(),
    mintAuthorityPriv: mintPriv,
  });
  // Sanity: honest mint validates.
  const honestSet = new Map();
  if (!(await validateOutpoint(honestMint.txid, 0, honestSet, store.fetch))) return false;

  // Fetch the honest mint's envelope payload (we'll reuse it verbatim).
  const honestRevealTx = await store.fetch(honestMint.txid);
  const honestEnvelopeHex = honestRevealTx.vin[0].witness[1];

  // Attacker builds a fresh commit-stub at a different funding outpoint.
  const attackerStub = synthCommitStub(store);
  // …and a reveal that points at THAT commit-stub but reuses the honest
  // envelope bytes (same issuer_sig, same commitment, same ct). The validator
  // will derive an anchor from the attacker's commit-stub vin[0] — different
  // from honestMint.anchor — and the issuer_sig won't verify.
  const replayRevealTx = {
    vin: [{
      txid: attackerStub.commitTxid, vout: 0,
      witness: [fakeWitnessSig(), honestEnvelopeHex, fakeControlBlock()],
    }],
  };
  const replayTxid = nextTxid();
  store.add(replayTxid, replayRevealTx);

  const set = new Map();
  return !(await validateOutpoint(replayTxid, 0, set, store.fetch));
});

await test('Tx with no envelope (regular P2WPKH-only witness) REJECTS', async () => {
  const store = new TxStore();
  const txid = nextTxid();
  store.add(txid, {
    vin: [{ txid: bytesToHex(new Uint8Array(32)), vout: 0,
            witness: [fakeWitnessSig(), bytesToHex(new Uint8Array(33))] }], // length 2, not 3
  });
  const set = new Map();
  return !(await validateOutpoint(txid, 0, set, store.fetch));
});

await test('Tx with non-tacit envelope (different magic) REJECTS', async () => {
  const store = new TxStore();
  // Build a script that has the right shape but wrong magic
  const fakeMagic = new TextEncoder().encode('NOPE!');
  const xonly = fakeXonly();
  const fakeScript = concatBytes(
    new Uint8Array([32]), xonly,
    new Uint8Array([0xac, 0x00, 0x63]),     // CHECKSIG, FALSE, IF
    new Uint8Array([fakeMagic.length]), fakeMagic,
    new Uint8Array([0x01, 0x01]),            // version push
    new Uint8Array([0x01, 0x21]),            // payload push
    new Uint8Array([0x68]),                  // ENDIF
  );
  const tx = {
    vin: [{ txid: bytesToHex(new Uint8Array(32)), vout: 0,
            witness: [fakeWitnessSig(), bytesToHex(fakeScript), fakeControlBlock()] }],
  };
  const txid = nextTxid();
  store.add(txid, tx);
  const set = new Map();
  return !(await validateOutpoint(txid, 0, set, store.fetch));
});

await test('Missing parent tx (orphan ancestor) REJECTS', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  // Now nuke the etch tx — fetcher returns null
  store.map.delete(etch.txid);
  const set = new Map();
  return !(await validateOutpoint(x.txid, 0, set, store.fetch));
});

console.log('\nMemoization & traversal:');

await test('Same outpoint validated twice hits cache (deterministic cost)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  const set = new Map();
  const a = await validateOutpoint(x.txid, 0, set, store.fetch);
  const sizeAfterFirst = set.size;
  const b = await validateOutpoint(x.txid, 0, set, store.fetch);
  const sizeAfterSecond = set.size;
  return a && b && sizeAfterSecond === sizeAfterFirst;
});

await test('Two siblings of same parent share validation work via memo', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  // Build a CXFER with 2 outputs (vout 0 and vout 1)
  const x = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [
      { amount: 300n, blinding: randomScalar() },
      { amount: 700n, blinding: randomScalar() },
    ],
  });
  const set = new Map();
  // Validate both outputs — should mark them via markAll on first call.
  const a = await validateOutpoint(x.txid, 0, set, store.fetch);
  const b = await validateOutpoint(x.txid, 1, set, store.fetch);
  // After first validate, both vout 0 and vout 1 should be in the memo
  return a && b && set.has(`${x.txid}:0`) && set.has(`${x.txid}:1`);
});

await test('Bad CXFER marks ALL its outputs invalid (markAll)', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  // Build a bad CXFER with a wrong asset_id, 2 outputs
  const aidBytes = hexToBytes(etch.assetIdHex);
  const wrongAid = sha256(new TextEncoder().encode('WRONG'));
  const r1 = randomScalar(), r2 = randomScalar();
  const { proof, commitments } = bpRangeAggProve([300n, 700n], [r1, r2]);
  const outCommits = commitments.map(pointToBytes);
  const sig = signSchnorr(
    computeKernelMsg(wrongAid, [{ txid: etch.txid, vout: 0 }], outCommits),
    bigintToBytes32(modN(r1 + r2 - etch.blinding)),
  );
  const payload = encodeCXferPayload({
    assetId: wrongAid, kernelSig: sig,
    outputs: [
      { commitment: outCommits[0], encryptedAmount: new Uint8Array(8) },
      { commitment: outCommits[1], encryptedAmount: new Uint8Array(8) },
    ],
    rangeproof: proof,
  });
  const env = encodeEnvelopeScript(fakeXonly(), payload);
  const tx = makeEnvelopeTx(env, [{ txid: etch.txid, vout: 0 }]);
  const txid = nextTxid();
  store.add(txid, tx);
  const set = new Map();
  // Validate vout 0 → should fail; both vout 0 and vout 1 should be marked false
  await validateOutpoint(txid, 0, set, store.fetch);
  return set.get(`${txid}:0`) === false && set.get(`${txid}:1`) === false;
});

console.log('\nBatch verification path (rpBatch):');

await test('rpBatch: deferred rangeproofs collected; batch verify clears them', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x1 = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [
      { amount: 300n, blinding: randomScalar() },
      { amount: 700n, blinding: randomScalar() },
    ],
  });
  const set = new Map();
  const batch = [];
  // Walk validates eagerly EXCEPT rangeproofs — those go in batch.
  const ok = await validateOutpoint(x1.txid, 0, set, store.fetch, 0, null, batch);
  // Resolve batch
  const batchOk = bpRangeAggBatchVerify(batch);
  // batch should contain at least 2 items (CETCH ancestor + CXFER itself)
  return ok && batchOk && batch.length >= 2;
});

await test('rpBatch: tampered rangeproof passes individual checks but batch fails', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  const x = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  // Tamper a byte squarely inside the rangeproof region. CXFER m=1 payload layout:
  //   T_CXFER(1) | aid(32) | sig(64) | N=1(1) | C(33) | ct(8) | rp_len(2) | rangeproof(688)
  // Rangeproof starts at payload byte 141. Envelope adds a 47-byte prefix
  // (push xonly + OP_CHECKSIG + OP_FALSE OP_IF + magic push + version push +
  // PUSHDATA2 length header), so envelope[188..] is the start of the rangeproof.
  // Pick byte 400 → mid-rangeproof, definitively not in commitment / kernel-sig / ct.
  const tx = await store.fetch(x.txid);
  const envBytes = new Uint8Array(hexToBytes(tx.vin[0].witness[1]));
  envBytes[400] ^= 1;
  tx.vin[0].witness[1] = bytesToHex(envBytes);
  const set = new Map();
  const batch = [];
  // Eager checks (envelope decode, asset_id, kernel sig) all pass — the bad bytes
  // are inside the rangeproof, which is deferred. Batch verify must catch it.
  await validateOutpoint(x.txid, 0, set, store.fetch, 0, null, batch);
  const batchOk = bpRangeAggBatchVerify(batch);
  return !batchOk;
});

console.log('\nMetadata propagation:');

await test('metadataOut populated for CETCH ancestor during walk', async () => {
  const store = new TxStore();
  const etch = synthCETCH(store, { ticker: 'WIDGET', decimals: 4, supply: 1000n });
  const x = synthCXFER(store, {
    assetIdHex: etch.assetIdHex,
    inputs: [{ txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding }],
    outputs: [{ amount: 1000n, blinding: randomScalar() }],
  });
  const set = new Map();
  const metadataOut = new Map();
  await validateOutpoint(x.txid, 0, set, store.fetch, 0, metadataOut);
  const meta = metadataOut.get(etch.assetIdHex);
  return meta && meta.ticker === 'WIDGET' && meta.decimals === 4 && meta.etchTxid === etch.txid;
});

await test('metadataOut populated via MINT path (ticker comes from CETCH)', async () => {
  const store = new TxStore();
  const mintPriv = secp.utils.randomPrivateKey();
  const mintAuth = secp.getPublicKey(mintPriv, true).slice(1);
  const etch = synthCETCH(store, { ticker: 'MINTED', decimals: 2, supply: 1000n, mintAuthority: mintAuth });
  const mint = synthMINT(store, {
    assetIdHex: etch.assetIdHex,
    etchTxid: etch.txid,
    amount: 500n, blinding: randomScalar(),
    mintAuthorityPriv: mintPriv,
  });
  const set = new Map();
  const metadataOut = new Map();
  await validateOutpoint(mint.txid, 0, set, store.fetch, 0, metadataOut);
  const meta = metadataOut.get(etch.assetIdHex);
  return meta && meta.ticker === 'MINTED' && meta.decimals === 2 && meta.mintable === true;
});

console.log('\nDeep chain (no depth bound):');

await test('Deep chain validates (300-hop CXFER chain accepts)', async () => {
  // The old recursive validateOutpoint had a hard depth cap (>200 hops
  // rejected). Issuer wallets fulfilling large airdrops accumulate ancestry
  // hop-counts equal to the batch count, so the cap was silently routing
  // deep change UTXOs into `h.inflated` and under-counting holdings.
  // The iterative refactor drops the cap; this test pins that behaviour.
  // 300 hops is comfortably past the old 200 cap (the old code would have
  // rejected this) without paying for stress-test runtime.
  const store = new TxStore();
  const etch = synthCETCH(store, { supply: 1000n });
  let prev = { txid: etch.txid, vout: 0, amount: 1000n, blinding: etch.blinding };
  for (let i = 0; i < 300; i++) {
    const r = randomScalar();
    const x = synthCXFER(store, {
      assetIdHex: etch.assetIdHex,
      inputs: [prev],
      outputs: [{ amount: 1000n, blinding: r }],
    });
    prev = { txid: x.txid, vout: 0, amount: 1000n, blinding: r };
  }
  const set = new Map();
  return await validateOutpoint(prev.txid, prev.vout, set, store.fetch);
}, 600000);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
