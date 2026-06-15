// JS mirror of cxfer-core/src/burn_deposit.rs — verdicts must match the Rust. The 9 linkage cases mirror the
// Rust verify_provenance_dag KATs one-for-one; the merkle test uses real double-SHA256; the composition test
// exercises inclusion + conservation + linkage ordering with injected crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeBurnDepositProvenance } from '../dapp/burn-deposit-provenance.js';

const stripHex = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const hexToBytes = (h) => {
  h = stripHex(h);
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
};
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const concat = (a, b) => {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
};

// ---- verifyProvenanceDag: the 9 KATs (mirror cxfer-core burn_deposit::tests) ----
const dag = makeBurnDepositProvenance({ outpointKey: (t, v) => `${t}:${v}` }).verifyProvenanceDag;
const opk = (t, v) => `${t}:${v}`;
const C0_OP = opk('00', 0);
const C0_CH = 'C0';
const A = () => ({ txid: '0a', inputs: [['00', 0, 'C0']], outputs: [[0, 'AA']] });

test('depth-1 distribution from C_0 is real', () => {
  assert.equal(dag(C0_OP, C0_CH, opk('0a', 0), 'AA', [A()]), true);
});
test('depth-2 chain is real', () => {
  const b = { txid: '0b', inputs: [['0a', 0, 'AA']], outputs: [[0, 'BB']] };
  assert.equal(dag(C0_OP, C0_CH, opk('0b', 0), 'BB', [A(), b]), true);
});
test('dangling input rejected', () => {
  const a = { txid: '0a', inputs: [['99', 0, '55']], outputs: [[0, 'AA']] };
  assert.equal(dag(C0_OP, C0_CH, opk('0a', 0), 'AA', [a]), false);
});
test('value-swapping seam rejected', () => {
  const b = { txid: '0b', inputs: [['0a', 0, 'FF']], outputs: [[0, 'BB']] }; // claims AA's output as FF
  assert.equal(dag(C0_OP, C0_CH, opk('0b', 0), 'BB', [A(), b]), false);
});
test('in-DAG double-spend rejected', () => {
  const b = { txid: '0b', inputs: [['00', 0, 'C0']], outputs: [[0, 'BB']] }; // both spend C_0
  assert.equal(dag(C0_OP, C0_CH, opk('0a', 0), 'AA', [A(), b]), false);
});
test('burned note must be produced', () => {
  assert.equal(dag(C0_OP, C0_CH, opk('0a', 0), 'DD', [A()]), false);
});
test('burned note consumed in DAG rejected', () => {
  const b = { txid: '0b', inputs: [['0a', 0, 'AA']], outputs: [[0, 'BB']] }; // (0a,0) spent by b
  assert.equal(dag(C0_OP, C0_CH, opk('0a', 0), 'AA', [A(), b]), false);
});
test('wrong C_0 commitment rejected', () => {
  const a = { txid: '0a', inputs: [['00', 0, '11']], outputs: [[0, 'AA']] }; // C_0 outpoint, wrong ch
  assert.equal(dag(C0_OP, C0_CH, opk('0a', 0), 'AA', [a]), false);
});
test('empty DAG rejected', () => {
  assert.equal(dag(C0_OP, C0_CH, opk('0a', 0), 'AA', []), false);
});

// ---- verifyProvenanceDagLeaves: mintable multi-leaf (mirror provenance_dag_leaves_admits_a_cmint_leaf) ----
test('multi-leaf admits a cmint-rooted note', () => {
  const bd = makeBurnDepositProvenance({ outpointKey: opk });
  const leaves = [[C0_OP, C0_CH], [opk('cc', 0), 'CD']]; // C_0 + an authorized cmint leaf
  // a note descending from the cmint leaf (not C_0) is real supply
  const a = { txid: '0a', inputs: [['cc', 0, 'CD']], outputs: [[0, 'AA']] };
  assert.equal(bd.verifyProvenanceDagLeaves(leaves, opk('0a', 0), 'AA', [a]), true);
  // the cmint OUTPOINT but a non-authorized commitment hash → rejected (leaves are value-matched)
  const b = { txid: '0b', inputs: [['cc', 0, 'FF']], outputs: [[0, 'BB']] };
  assert.equal(bd.verifyProvenanceDagLeaves(leaves, opk('0b', 0), 'BB', [b]), false);
  // the fixed-supply single-leaf wrapper still rejects a cmint-rooted note (C_0 only)
  assert.equal(dag(C0_OP, C0_CH, opk('0a', 0), 'AA', [a]), false);
});

// ---- verifyCmintAuthorized (mirror burn_deposit::verify_cmint_authorized; injected crypto) ----
// A "good" mintable scenario, then each gate perturbed → null. Fakes mirror the Rust verdicts structurally;
// the REAL crypto is validated by the reflection guest native-exec (the MINTABLE burn-deposit fixture).
function cmintHarness(overrides = {}) {
  const ASSET = 'aa'.repeat(32);
  const COMMIT = '02' + '11'.repeat(32); // compressed commitment (33B)
  const ISSUER_SIG = 'cc'.repeat(64);
  const REVEAL = 'reveal-tx';
  const COMMITTX = 'commit-tx';
  const COMMIT_TXID = 'dd'.repeat(32);
  const REVEAL_TXID = 'ee'.repeat(32);
  const ANCHOR_TXID = '5a'.repeat(32);
  const state = {
    parseAsset: ASSET, // verifyCmintAuthorized checks env asset == ASSET
    sigOk: true,
    rangeOk: true,
    revealSpendsCommit: true,
    ...overrides,
  };
  const bd = makeBurnDepositProvenance({
    outpointKey: opk,
    sha256: (b) => b, // identity → mintMsg = the concatenated preimage; bip340Verify ignores it
    decompress: (c) => (c ? { c } : null),
    commitmentHashCompressed: (c) => `ch(${c})`,
    extractTaprootEnvelope: (tx) => (tx === REVEAL ? 'env' : null),
    parseCmint: (env) => (env === 'env'
      ? { asset: state.parseAsset, etchTxid: 'ff'.repeat(32), commitment: COMMIT, encryptedAmount: '00'.repeat(8), rangeProof: 'rp', issuerSig: ISSUER_SIG }
      : null),
    computeTxid: (tx) => (tx === COMMITTX ? COMMIT_TXID : tx === REVEAL ? REVEAL_TXID : null),
    extractInputs: (tx) => {
      if (tx === REVEAL) return [{ prevTxid: state.revealSpendsCommit ? COMMIT_TXID : '99'.repeat(32), prevVout: 0 }];
      if (tx === COMMITTX) return [{ prevTxid: ANCHOR_TXID, prevVout: 0 }];
      return null;
    },
    bip340Verify: () => state.sigOk,
    verifyRange: () => state.rangeOk,
  });
  return { bd, ASSET, REVEAL, COMMITTX, COMMIT, REVEAL_TXID };
}

test('cmint: an authorized mint is a valid supply leaf', () => {
  const { bd, ASSET, REVEAL, COMMITTX, COMMIT, REVEAL_TXID } = cmintHarness();
  const leaf = bd.verifyCmintAuthorized(ASSET, 'bb'.repeat(32), REVEAL, COMMITTX);
  assert.deepEqual(leaf, [opk(REVEAL_TXID, 0), `ch(${COMMIT})`], 'leaf = (reveal:0, ch(commitment))');
});
test('cmint: non-mintable (zero authority) admits nothing', () => {
  const { bd, ASSET, REVEAL, COMMITTX } = cmintHarness();
  assert.equal(bd.verifyCmintAuthorized(ASSET, '00'.repeat(32), REVEAL, COMMITTX), null);
});
test('cmint: asset mismatch rejected', () => {
  const { bd, ASSET, REVEAL, COMMITTX } = cmintHarness({ parseAsset: 'be'.repeat(32) });
  assert.equal(bd.verifyCmintAuthorized(ASSET, 'bb'.repeat(32), REVEAL, COMMITTX), null);
});
test('cmint: reveal not spending the commit tx rejected (broken commit/reveal pair)', () => {
  const { bd, ASSET, REVEAL, COMMITTX } = cmintHarness({ revealSpendsCommit: false });
  assert.equal(bd.verifyCmintAuthorized(ASSET, 'bb'.repeat(32), REVEAL, COMMITTX), null);
});
test('cmint: bad issuer signature rejected', () => {
  const { bd, ASSET, REVEAL, COMMITTX } = cmintHarness({ sigOk: false });
  assert.equal(bd.verifyCmintAuthorized(ASSET, 'bb'.repeat(32), REVEAL, COMMITTX), null);
});
test('cmint: out-of-range minted commitment rejected', () => {
  const { bd, ASSET, REVEAL, COMMITTX } = cmintHarness({ rangeOk: false });
  assert.equal(bd.verifyCmintAuthorized(ASSET, 'bb'.repeat(32), REVEAL, COMMITTX), null);
});
test('cmint: signed message binds the commit anchor (anti-re-wrap)', () => {
  // The signature must cover domain ‖ asset ‖ commitment ‖ commit-anchor; capture the message the verifier
  // sees and assert the commit tx's first-input outpoint (the anchor) is in it — so a re-broadcast of the
  // same mint envelope in a FRESH commit/reveal pair (different anchor) signs a different message → rejected.
  const ANCHOR_TXID = '5a'.repeat(32);
  const ASSET = 'aa'.repeat(32);
  const COMMIT = '02' + '11'.repeat(32);
  const AMOUNT_CT = 'a1a2a3a4a5a6a7a8';
  let seen = null;
  const bd = makeBurnDepositProvenance({
    outpointKey: opk,
    sha256: (b) => b,
    decompress: (c) => ({ c }),
    commitmentHashCompressed: (c) => `ch(${c})`,
    extractTaprootEnvelope: () => 'env',
    parseCmint: () => ({ asset: ASSET, etchTxid: 'ff'.repeat(32), commitment: COMMIT, encryptedAmount: AMOUNT_CT, rangeProof: 'rp', issuerSig: 'cc'.repeat(64) }),
    computeTxid: (tx) => (tx === 'commit-tx' ? 'dd'.repeat(32) : 'ee'.repeat(32)),
    extractInputs: (tx) => (tx === 'reveal-tx'
      ? [{ prevTxid: 'dd'.repeat(32), prevVout: 0 }]
      : [{ prevTxid: ANCHOR_TXID, prevVout: 7 }]),
    bip340Verify: (_sig, msg) => { seen = msg; return true; },
    verifyRange: () => true,
  });
  bd.verifyCmintAuthorized(ASSET, 'bb'.repeat(32), 'reveal-tx', 'commit-tx');
  const msgHex = [...seen].map((x) => x.toString(16).padStart(2, '0')).join('');
  // canonical layout: DOMAIN ‖ asset ‖ anchor_txid ‖ anchor_vout_LE ‖ commitment ‖ amount_ct
  assert.equal(
    msgHex,
    bytesToHex(new TextEncoder().encode('tacit-mint-v1')) + ASSET + ANCHOR_TXID + '07000000' + COMMIT + AMOUNT_CT,
    'binds domain, asset, commit-anchor (txid+vout), commitment, amount_ct in canonical order',
  );
});

// ---- verifyMerklePath (real double-SHA256, mirror bitcoin::verify_merkle_path test) ----
test('merkle path verifies inclusion', () => {
  const mk = makeBurnDepositProvenance({ sha256: nobleSha256 }).verifyMerklePath;
  const t = [0, 1, 2, 3].map((i) => i.toString(16).padStart(2, '0').repeat(32));
  const dsha = (aHex, bHex) => bytesToHex(nobleSha256(nobleSha256(concat(hexToBytes(aHex), hexToBytes(bHex)))));
  const h01 = dsha(t[0], t[1]);
  const h23 = dsha(t[2], t[3]);
  const root = dsha(h01, h23);
  assert.equal(mk(t[0], [t[1], h23], 0), root, 'index-0 path → root');
  assert.equal(mk(t[1], [t[0], h23], 1), root, 'index-1 path → root');
  assert.notEqual(mk(t[1], [t[2], h23], 1), root, 'wrong sibling rejected');
  assert.equal(mk(t[0], [], 0), t[0], 'single-tx path = txid');
});

// ---- verifyProvenance composition (injected crypto; real linkage + merkle) ----
test('verifyProvenance composes inclusion + conservation + linkage', () => {
  let conserv = true;
  const bd = makeBurnDepositProvenance({
    outpointKey: (t, v) => `${t}:${v}`,
    sha256: nobleSha256,
    verifyCxferConservation: () => conserv,
    commitmentHashCompressed: (c) => `ch(${c})`,
    decompress: (c) => (c ? { c } : null),
  });
  const txid = '0a'.repeat(32);
  const mkCx = () => ({
    txid,
    inputOutpoints: [['00'.repeat(32), 0]],
    inputCommitments: ['c0c'],
    outputCommitments: ['oc'],
    outputVouts: [0],
    rangeProof: new Uint8Array(),
    kernelSig: new Uint8Array(64),
    merkleSiblings: [],
    merkleIndex: 0,
    confirmedBlockRoot: txid, // single-tx block: verifyMerklePath(txid, [], 0) === txid
  });
  const c0Op = `${'00'.repeat(32)}:0`;
  const c0Ch = 'ch(c0c)';
  const bOp = `${txid}:0`;
  const bCh = 'ch(oc)';

  assert.equal(bd.verifyProvenance('asset', c0Op, c0Ch, bOp, bCh, [mkCx()]), true, 'valid depth-1 verifies');

  conserv = false;
  assert.equal(bd.verifyProvenance('asset', c0Op, c0Ch, bOp, bCh, [mkCx()]), false, 'non-conserving rejected');

  conserv = true;
  const bad = mkCx();
  bad.confirmedBlockRoot = 'ff'.repeat(32);
  assert.equal(bd.verifyProvenance('asset', c0Op, c0Ch, bOp, bCh, [bad]), false, 'unconfirmed inclusion rejected');
});
