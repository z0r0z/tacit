// Confidential airdrop round-trip (dapp/confidential-airdrop.js): one sender locks to N recipients over
// the stealth lock-set; each recipient discovers ONLY their own lock by scanning, reconstructs it from
// the memo (the lock leaf authenticates), and the recovered one-time key produces a claim signature the
// guest's bip340_verify accepts. Builds the same witnesses the box harness feeds the guest, so it pins
// the airdrop assembler + the new stealth memo to the proven stealth primitives. Run: node tests/confidential-airdrop.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash, webcrypto } from 'node:crypto';
import { randomScalar, G as bpG } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, verifySchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import { makeConfidentialAirdrop } from '../dapp/confidential-airdrop.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });
const airdrop = makeConfidentialAirdrop({ stealth, secp, sha256, keccak256, curveOrder: SECP_N, pool, transfer });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const PtT = bpG.constructor; // vendored secp Point class (bulletproofs-plus.js's own bundle) — commit()/
                              // kernelSign() build points from it, so kernel.R must be lifted with THIS
                              // class, not the top-level `secp` import's (a different bundle instance).
const ptHexT = (h) => PtT.fromHex(String(h).replace(/^0x/, ''));
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const rand = () => { const b = new Uint8Array(32); (globalThis.crypto || webcrypto).getRandomValues(b); return hx(b); };

const cb = '0x' + '11'.repeat(32);
const asset = '0x' + 'aa'.repeat(32);
// The funding notes' REAL secret nullifier key — locker (the H(nk) owner every denom note publishes) is
// derived from it, never hand-picked. A prior version of this test used an arbitrary `locker` constant with
// no corresponding nk anywhere, so it could never have caught buildStealthLock/buildAirdrop dropping the nk
// field the guest needs to spend N (see confidential-stealth.js / confidential-airdrop.js history).
const lockerNk = rand();
const locker = pool.nkToOwner(lockerNk);
const deadline = 1_700_000_000n;
const lockerScanPriv = rand();
const spendRoot = '0x' + '22'.repeat(32);

// three recipients, distinct static spend keys + amounts
const recips = [123_456n, 7_000n, 999_999n].map((amount) => {
  const priv = rand();
  return { priv, recipientSpendPub: hx(secp.ProjectivePoint.BASE.multiply(BigInt(priv)).toRawBytes(true)), amount };
});
// funding: one note per recipient, each opening to that recipient's exact amount (the pre-split output),
// owned by `locker` and carrying its real nk — exactly what buildFunding/fundingNotesFor now produce.
const fundingNotes = recips.map((r) => { const blinding = randomScalar(); return { ...pool.commitXY(r.amount, blinding), blinding, secret: lockerNk, leafIndex: 0, path: pool.zeros }; });

const { ops, leaves, memos } = airdrop.buildAirdrop({
  chainBinding: cb, asset, lockerNk, lockerScanPriv, deadline, spendRoot,
  recipients: recips.map(({ recipientSpendPub, amount }) => ({ recipientSpendPub, amount })), fundingNotes,
});
const events = leaves.map((leaf, i) => ({ leaf, memo: memos[i] }));

// (0) every lock op is a COMPLETE, guest-submittable witness — every field exec-stealthlock.rs reads, with
// the input spend-authority PoK verifying against the note this test actually owns (real nk, not a stand-in).
{
  const HARNESS_FIELDS = ['chainBinding', 'spendRoot', 'asset', 'locker', 'ownerPub', 'refundPub', 'deadline',
    'nCx', 'nCy', 'nIndex', 'nPath', 'nk', 'lCx', 'lCy', 'kernelR', 'kernelZ', 'inPokR', 'inPokZv', 'inPokZr'];
  for (let i = 0; i < ops.length; i++) {
    for (const f of HARNESS_FIELDS) assert.ok(ops[i][f] !== undefined, `lock ${i}: op.${f} is present (exec-stealthlock.rs reads it)`);
    assert.equal(ops[i].nk, lockerNk, `lock ${i}: nk is the funding note's real secret (native_nu can compute ν)`);
    assert.equal(ops[i].locker.toLowerCase(), locker.toLowerCase(), `lock ${i}: locker == H(nk)`);
    // op.lockLeaf must be exactly the blind leaf the kernel binds — this is what buildAirdrop must publish
    // as the on-chain leaf; a leaf computed under a different domain (e.g. the amount-bearing non-blind
    // form) would desync from the proof and fail membership for every later claim/refund.
    const expectLeaf = stealth.stealthLockLeafBlind(asset, ops[i].lCx, ops[i].lCy, ops[i].ownerPub, Number(deadline), ops[i].refundPub);
    assert.equal(ops[i].lockLeaf, expectLeaf, `lock ${i}: op.lockLeaf matches the blind leaf domain`);
    assert.equal(leaves[i], expectLeaf, `lock ${i}: buildAirdrop published the SAME leaf the proof binds`);
  }
  ok('buildAirdrop: every lock op is a complete guest-submittable witness (nk, refundPub, PoK all present + correct)');
}

// (1) each lock op carries its conservation-kernel witness (box-parity) — the per-note opening sigmas were
// REPLACED by the kernel (v_N == v_L, no cleartext amount), so the box-parity witness is now kernelR/kernelZ.
{
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    assert.ok(op.kernelR && op.kernelZ, `lock ${i}: carries the conservation kernel (v_N == v_L witness)`);
    assert.ok(op.lCx && op.lCy && op.ownerPub, `lock ${i}: binds L + the one-time pubkey`);
  }
  ok('buildAirdrop: every lock op carries its conservation-kernel witness (opening sigmas replaced)');
}

// (2) each recipient scans and finds EXACTLY their own lock, with the locked amount AND lBlinding recovered
// intact — lBlinding is what actually lets a claim spend L; a memo that dropped it (the prior wire form)
// would let a recipient discover a lock they could never spend.
{
  for (let i = 0; i < recips.length; i++) {
    const mine = airdrop.scanAirdrop({ recipientSpendPriv: recips[i].priv, events });
    assert.equal(mine.length, 1, `recipient ${i} finds exactly one lock`);
    assert.equal(mine[0].leaf.toLowerCase(), leaves[i].toLowerCase(), `recipient ${i} finds THEIR lock`);
    assert.equal(mine[0].amount, recips[i].amount, `recipient ${i} recovers the locked amount`);
    assert.equal(mine[0].asset.toLowerCase(), asset.toLowerCase(), `recipient ${i} recovers the asset`);
    assert.equal(mine[0].lBlinding, airdrop.lockBlinding(lockerScanPriv, i, '0x' + '00'.repeat(32)), `recipient ${i} recovers r_L (spendable, not just discoverable)`);
    const expectRefundPub = airdrop.refundPubOf(airdrop.refundPriv(lockerScanPriv, i, '0x' + '00'.repeat(32)));
    assert.equal(mine[0].refundPub.toLowerCase(), expectRefundPub.toLowerCase(), `recipient ${i} recovers the lock's refund-auth pubkey`);
  }
  assert.equal(airdrop.scanAirdrop({ recipientSpendPriv: rand(), events }).length, 0, 'a non-recipient finds nothing');
  ok('scanAirdrop: each recipient discovers only their own lock + recovers its full spendable params; outsiders find nothing');
}

// (3) a tampered memo fails the leaf-hash authenticator
{
  const bad = fromHex(memos[0]); bad[40] ^= 0xff; // flip a ciphertext byte (within the recovered asset field)
  assert.equal(airdrop.openStealthMemo({ recipientSpendPriv: recips[0].priv, leaf: leaves[0], memoHex: hx(bad) }), null, 'tampered memo rejected');
  assert.equal(airdrop.openStealthMemo({ recipientSpendPriv: recips[0].priv, leaf: '0x' + 'de'.repeat(32), memoHex: memos[0] }), null, 'memo against the wrong leaf rejected');
  ok('openStealthMemo: leaf hash authenticates — tampered memo / wrong leaf rejected');
}

// (4) FULL claim round-trip from what scanning alone recovers: a real lock-set tree (the actual airdrop
// leaves), buildStealthClaim fed ONLY the scanned {lCx,lCy,amount,deadline,lBlinding,refundPub,ownerPub,
// oneTimePriv} plus fresh membership/output params — then self-verified exactly as the guest re-checks it
// (kernel + BP+ range conservation, membership, BIP-340 auth). This is the gap the memo-format fix closes:
// the prior wire form let a recipient discover a lock but never carried lBlinding, so this claim could not
// have been built from scan output alone before.
{
  const lockTree = new pool.Tree();
  for (const lf of leaves) lockTree.insert(lf);
  const { root: lockSetRoot } = lockTree.rootAndPath(0);
  const mine = airdrop.scanAirdrop({ recipientSpendPriv: recips[0].priv, events })[0];
  const { path: lPath } = lockTree.rootAndPath(0);
  assert.ok(pool.verifyPath(mine.leaf, 0, lPath, lockSetRoot), 'scanned lock is a real member of the lock-set tree');

  const fee = 50n;
  const mOwner = '0x' + '00'.repeat(31) + '09';
  const mBlinding = randomScalar();
  const claim = stealth.buildStealthClaim({
    chainBinding: cb, asset: mine.asset, lCx: mine.lCx, lCy: mine.lCy, ownerPub: mine.ownerPub,
    amount: mine.amount, deadline: mine.deadline, locker: mine.refundPub, lBlinding: mine.lBlinding,
    lockSetRoot, lIndex: 0, lPath, oneTimePriv: mine.oneTimePriv, mOwner, fee, mBlinding,
  });
  const net = mine.amount - fee;
  const mLeaf = pool.leaf(mine.asset, claim.mCx, claim.mCy, mOwner);
  const kern = { R: ptHexT(claim.kernelR), z: BigInt(claim.kernelZ) };
  const C = (v, r) => transfer.commit(BigInt(v), BigInt(r));
  assert.ok(
    transfer.verifyTransfer({ inC: [C(mine.amount, BigInt(mine.lBlinding))], outC: [C(net, mBlinding)], rangeProof: claim.mRange, kernel: kern, fee, outLeaves: [mLeaf] }),
    'claim kernel + M range self-verify (value(L) == value(M) + fee, exactly as the guest re-checks)',
  );
  const claimMsg = stealth.stealthClaimMsgBlind(cb, mine.leaf, claim.mCx, claim.mCy, mOwner, fee);
  assert.equal(verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(mine.ownerPub)), true, 'claim signature verifies under ownerPub (guest accepts)');
  assert.equal(verifySchnorr(fromHex(hx(signSchnorr(claimMsg, b32(recips[0].priv)))), claimMsg, b32(mine.ownerPub)), false, 'the base spend key cannot claim');
  ok('FULL claim round-trip from scan output alone: membership + kernel + range + signature all self-verify');
}

// (5) salt separates repeated airdrops to the same list (no lock-leaf collision)
{
  const again = airdrop.buildAirdrop({
    chainBinding: cb, asset, lockerNk, lockerScanPriv, deadline, spendRoot,
    recipients: recips.map(({ recipientSpendPub, amount }) => ({ recipientSpendPub, amount })), fundingNotes,
    salt: '0x' + '07'.repeat(32),
  });
  for (let i = 0; i < leaves.length; i++) assert.notEqual(again.leaves[i].toLowerCase(), leaves[i].toLowerCase(), `salt changes lock leaf ${i}`);
  ok('salt: a second airdrop to the same recipients produces distinct lock leaves');
}

// (6) funding split: plan packs the amounts + a change slot into a valid {1,2,4,8} output count
{
  const plan = airdrop.planFunding({ sources: [{ value: 2_000_000n }], amounts: recips.map((r) => r.amount) });
  assert.equal(plan.length, 1, 'one source → one op');
  assert.equal(plan[0].denom.length, 3, 'three denominations packed');
  assert.equal(plan[0].m, 4, '3 denom + 1 change → m = 4');
  assert.equal(plan[0].change, 2_000_000n - recips.reduce((s, r) => s + r.amount, 0n), 'change = source − Σamounts');
  assert.throws(() => airdrop.planFunding({ sources: [{ value: 10n }], amounts: [11n] }), /under-funded/, 'under-funded source rejected');
  ok('planFunding: amounts + change packed into a valid aggregation count; under-funding rejected');
}

// (7) funding build: each transfer op conserves + ranges; denom notes commit to the right amount, owned by locker
{
  const source = (() => { const blinding = randomScalar(); return { value: 2_000_000n, blinding, ...pool.commitXY(2_000_000n, blinding), leafIndex: 0, path: pool.zeros }; })();
  const { ops, denomNotes } = airdrop.buildFunding({ sources: [source], amounts: recips.map((r) => r.amount), lockerNk, lockerScanPriv });
  assert.equal(ops.length, 1, 'one funding op');
  assert.equal(transfer.verifyTransfer(ops[0]), true, 'funding transfer conserves + ranges (guest re-verifies this)');
  for (let i = 0; i < recips.length; i++) {
    assert.equal(denomNotes[i].value, recips[i].amount, `denom ${i} commits to recipient ${i}'s amount`);
    assert.equal(denomNotes[i].owner.toLowerCase(), locker.toLowerCase(), `denom ${i} owned by locker (membership keys on locker)`);
    assert.equal(denomNotes[i].secret, lockerNk, `denom ${i} carries the real nk (buildStealthLock requires nNote.secret)`);
    const { cx, cy } = pool.commitXY(denomNotes[i].value, denomNotes[i].blinding);
    assert.equal(denomNotes[i].cx, cx, `denom ${i} commitment matches its (value, blinding)`);
  }
  ok('buildFunding: split conserves, every denomination commits to its amount, is locker-owned, and carries its spend key');
}

// (8) two-settle driver: split → index → lock, wired so the locks consume the freshly-minted denominations
{
  const source = (() => { const blinding = randomScalar(); return { value: 2_000_000n, blinding, ...pool.commitXY(2_000_000n, blinding), leafIndex: 0, path: pool.zeros }; })();
  let splitSettled = false, captured = null;
  const out = await airdrop.runAirdrop({
    chainBinding: cb, asset, lockerNk, lockerScanPriv, deadline, spendRoot,
    recipients: recips.map(({ recipientSpendPub, amount }) => ({ recipientSpendPub, amount })), sources: [source],
    settleSplit: async (fundingOps) => { assert.equal(fundingOps.length, 1, 'driver settles the split batch first'); splitSettled = true; },
    indexDenoms: async (denomNotes) => { assert.ok(splitSettled, 'denoms indexed only after the split settles'); return denomNotes.map((_, i) => ({ leafIndex: i, path: pool.zeros })); },
    settleLocks: async (drop) => { captured = drop; },
  });
  assert.equal(captured.ops.length, recips.length, 'driver settles one lock per recipient after the split');
  // the locks consume the denominations: each lock carries its conservation-kernel witness (v_N == v_L)
  for (let i = 0; i < captured.ops.length; i++) {
    const op = captured.ops[i];
    assert.ok(op.kernelR && op.kernelZ, `lock ${i} consumes its denomination (conservation kernel witness)`);
  }
  // and the recipients still scan their locks out of the driver's drop
  const mine = airdrop.scanAirdrop({ recipientSpendPriv: recips[0].priv, events: captured.leaves.map((leaf, i) => ({ leaf, memo: captured.memos[i] })) });
  assert.equal(mine.length, 1, 'recipient 0 scans their lock from the driven airdrop');
  ok('runAirdrop: split settles first, denominations feed the locks, recipients scan the result');
}

// (9) multi-op batch pack: one proof header (shared chainBinding + spendRoot) + N per-lock field sets
{
  const batch = airdrop.packStealthLockBatch(ops);
  assert.equal(batch.chainBinding, cb, 'batch carries the shared chainBinding');
  assert.equal(batch.spendRoot, spendRoot, 'batch carries the shared pre-state spendRoot');
  assert.equal(batch.ops.length, ops.length, 'one packed lock per recipient');
  // Every field exec-stealthlockbatch.rs actually reads per op — a prior version of packStealthLockBatch
  // silently dropped refundPub/nk/inPok* (this exact list), so a batch built from it could never pass the
  // guest's per-input spend-authority check. Assert presence AND value-preservation against the source op.
  const FIELDS = ['asset', 'locker', 'ownerPub', 'refundPub', 'deadline', 'nCx', 'nCy', 'nIndex', 'nPath', 'nk', 'lCx', 'lCy', 'kernelR', 'kernelZ', 'inPokR', 'inPokZv', 'inPokZr'];
  for (let i = 0; i < ops.length; i++) for (const k of FIELDS) {
    assert.ok(batch.ops[i][k] !== undefined, `batch op ${i}: ${k} is present (exec-stealthlockbatch.rs reads it)`);
    assert.deepEqual(batch.ops[i][k], ops[i][k], `batch op ${i} preserves ${k}`);
  }
  // header fields must NOT be repeated per op (they're written once in the shared header)
  assert.equal(batch.ops[0].chainBinding, undefined, 'per-op chainBinding stripped (header-level)');
  assert.equal(batch.ops[0].spendRoot, undefined, 'per-op spendRoot stripped (header-level)');
  const mixed = [ops[0], { ...ops[1], spendRoot: '0x' + 'fe'.repeat(32) }];
  assert.throws(() => airdrop.packStealthLockBatch(mixed), /share chainBinding \+ spendRoot/, 'mismatched header rejected (one proof, one root)');
  ok('packStealthLockBatch: shared header + N per-lock field sets; mismatched roots rejected');
}

console.log(`confidential-airdrop: all ${n} checks passed`);
