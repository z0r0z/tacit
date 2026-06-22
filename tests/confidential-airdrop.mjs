// Confidential airdrop round-trip (dapp/confidential-airdrop.js): one sender locks to N recipients over
// the stealth lock-set; each recipient discovers ONLY their own lock by scanning, reconstructs it from
// the memo (the lock leaf authenticates), and the recovered one-time key produces a claim signature the
// guest's bip340_verify accepts. Builds the same witnesses the box harness feeds the guest, so it pins
// the airdrop assembler + the new stealth memo to the proven stealth primitives. Run: node tests/confidential-airdrop.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash, webcrypto } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
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

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const rand = () => { const b = new Uint8Array(32); (globalThis.crypto || webcrypto).getRandomValues(b); return hx(b); };

const cb = '0x' + '11'.repeat(32);
const asset = '0x' + 'aa'.repeat(32);
const locker = '0x' + '00'.repeat(31) + '01';
const deadline = 1_700_000_000n;
const lockerScanPriv = rand();
const spendRoot = '0x' + '22'.repeat(32);

// three recipients, distinct static spend keys + amounts
const recips = [123_456n, 7_000n, 999_999n].map((amount) => {
  const priv = rand();
  return { priv, recipientSpendPub: hx(secp.ProjectivePoint.BASE.multiply(BigInt(priv)).toRawBytes(true)), amount };
});
// funding: one note per recipient, each opening to that recipient's exact amount (the pre-split output)
const fundingNotes = recips.map((r) => { const blinding = randomScalar(); return { ...pool.commitXY(r.amount, blinding), blinding, leafIndex: 0, path: pool.zeros }; });

const { ops, leaves, memos } = airdrop.buildAirdrop({
  chainBinding: cb, asset, locker, lockerScanPriv, deadline, spendRoot,
  recipients: recips.map(({ recipientSpendPub, amount }) => ({ recipientSpendPub, amount })), fundingNotes,
});
const events = leaves.map((leaf, i) => ({ leaf, memo: memos[i] }));

// (1) each lock's N + L openings verify against the reconstructed lock context (box-parity of the witness)
{
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const ctx = pool.intentContext('tacit-stealth-lock-intent-v1', cb, asset, asset,
      [[fundingNotes[i].cx, fundingNotes[i].cy, locker], [op.lCx, op.lCy, op.ownerPub]], [recips[i].amount, deadline]);
    assert.equal(pool.verifyOpeningSigma(fundingNotes[i].cx, fundingNotes[i].cy, recips[i].amount, op.nSigR, op.nSigZ, ctx), true, `lock ${i}: N opening verifies`);
    assert.equal(pool.verifyOpeningSigma(op.lCx, op.lCy, recips[i].amount, op.lSigR, op.lSigZ, ctx), true, `lock ${i}: L opening verifies`);
  }
  ok('buildAirdrop: every lock op N + L openings verify (box-parity witnesses)');
}

// (2) each recipient scans and finds EXACTLY their own lock, with the locked amount recovered intact
{
  for (let i = 0; i < recips.length; i++) {
    const mine = airdrop.scanAirdrop({ recipientSpendPriv: recips[i].priv, events });
    assert.equal(mine.length, 1, `recipient ${i} finds exactly one lock`);
    assert.equal(mine[0].leaf.toLowerCase(), leaves[i].toLowerCase(), `recipient ${i} finds THEIR lock`);
    assert.equal(mine[0].amount, recips[i].amount, `recipient ${i} recovers the locked amount`);
    assert.equal(mine[0].asset.toLowerCase(), asset.toLowerCase(), `recipient ${i} recovers the asset`);
  }
  assert.equal(airdrop.scanAirdrop({ recipientSpendPriv: rand(), events }).length, 0, 'a non-recipient finds nothing');
  ok('scanAirdrop: each recipient discovers only their own lock + recovers its params; outsiders find nothing');
}

// (3) a tampered memo fails the leaf-hash authenticator
{
  const bad = fromHex(memos[0]); bad[40] ^= 0xff; // flip a ciphertext byte (the recovered Cx)
  assert.equal(airdrop.openStealthMemo({ recipientSpendPriv: recips[0].priv, leaf: leaves[0], memoHex: hx(bad) }), null, 'tampered memo rejected');
  assert.equal(airdrop.openStealthMemo({ recipientSpendPriv: recips[0].priv, leaf: '0x' + 'de'.repeat(32), memoHex: memos[0] }), null, 'memo against the wrong leaf rejected');
  ok('openStealthMemo: leaf hash authenticates — tampered memo / wrong leaf rejected');
}

// (4) the recovered one-time key claims: M opens to amount − fee + the claim sig verifies under ownerPub
{
  const mine = airdrop.scanAirdrop({ recipientSpendPriv: recips[0].priv, events })[0];
  const fee = 50n, net = recips[0].amount - fee;
  const mOwner = '0x' + '00'.repeat(31) + '09';
  const mBlinding = randomScalar();
  const claim = stealth.buildStealthClaim({
    chainBinding: cb, asset: mine.asset, lCx: mine.lCx, lCy: mine.lCy, ownerPub: mine.ownerPub,
    amount: mine.amount, deadline: mine.deadline, locker: mine.locker,
    lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros,
    oneTimePriv: mine.oneTimePriv, mOwner, fee, mBlinding,
  });
  const mCtx = pool.intentContext('tacit-stealth-claim-out-v1', cb, asset, asset, [[claim.mCx, claim.mCy, mOwner]], [recips[0].amount, fee]);
  assert.equal(pool.verifyOpeningSigma(claim.mCx, claim.mCy, net, claim.mSigR, claim.mSigZ, mCtx), true, 'M opens to amount − fee');
  const claimMsg = stealth.stealthClaimMsg(cb, mine.leaf, claim.mCx, claim.mCy, mOwner, recips[0].amount, fee);
  assert.equal(verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(mine.ownerPub)), true, 'one-time claim sig verifies under ownerPub (guest accepts)');
  assert.equal(verifySchnorr(fromHex(hx(signSchnorr(claimMsg, b32(recips[0].priv)))), claimMsg, b32(mine.ownerPub)), false, 'the base spend key cannot claim');
  ok('claim round-trip: scanned lock → one-time key signs a claim the guest accepts; base key cannot');
}

// (5) salt separates repeated airdrops to the same list (no lock-leaf collision)
{
  const again = airdrop.buildAirdrop({
    chainBinding: cb, asset, locker, lockerScanPriv, deadline, spendRoot,
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
  const { ops, denomNotes } = airdrop.buildFunding({ sources: [source], amounts: recips.map((r) => r.amount), locker, lockerScanPriv });
  assert.equal(ops.length, 1, 'one funding op');
  assert.equal(transfer.verifyTransfer(ops[0]), true, 'funding transfer conserves + ranges (guest re-verifies this)');
  for (let i = 0; i < recips.length; i++) {
    assert.equal(denomNotes[i].value, recips[i].amount, `denom ${i} commits to recipient ${i}'s amount`);
    assert.equal(denomNotes[i].owner.toLowerCase(), locker.toLowerCase(), `denom ${i} owned by locker (membership keys on locker)`);
    const { cx, cy } = pool.commitXY(denomNotes[i].value, denomNotes[i].blinding);
    assert.equal(denomNotes[i].cx, cx, `denom ${i} commitment matches its (value, blinding)`);
  }
  ok('buildFunding: split conserves, every denomination commits to its amount and is locker-owned');
}

// (8) two-settle driver: split → index → lock, wired so the locks consume the freshly-minted denominations
{
  const source = (() => { const blinding = randomScalar(); return { value: 2_000_000n, blinding, ...pool.commitXY(2_000_000n, blinding), leafIndex: 0, path: pool.zeros }; })();
  let splitSettled = false, captured = null;
  const out = await airdrop.runAirdrop({
    chainBinding: cb, asset, locker, lockerScanPriv, deadline, spendRoot,
    recipients: recips.map(({ recipientSpendPub, amount }) => ({ recipientSpendPub, amount })), sources: [source],
    settleSplit: async (fundingOps) => { assert.equal(fundingOps.length, 1, 'driver settles the split batch first'); splitSettled = true; },
    indexDenoms: async (denomNotes) => { assert.ok(splitSettled, 'denoms indexed only after the split settles'); return denomNotes.map((_, i) => ({ leafIndex: i, path: pool.zeros })); },
    settleLocks: async (drop) => { captured = drop; },
  });
  assert.equal(captured.ops.length, recips.length, 'driver settles one lock per recipient after the split');
  // the locks consume the denominations: each lock's N opening verifies against the funding denom commitment
  for (let i = 0; i < captured.ops.length; i++) {
    const op = captured.ops[i], d = out.funding.denomNotes[i];
    const lctx = pool.intentContext('tacit-stealth-lock-intent-v1', cb, asset, asset, [[d.cx, d.cy, locker], [op.lCx, op.lCy, op.ownerPub]], [recips[i].amount, deadline]);
    assert.equal(pool.verifyOpeningSigma(d.cx, d.cy, recips[i].amount, op.nSigR, op.nSigZ, lctx), true, `lock ${i} consumes its denomination`);
  }
  // and the recipients still scan their locks out of the driver's drop
  const mine = airdrop.scanAirdrop({ recipientSpendPriv: recips[0].priv, events: captured.leaves.map((leaf, i) => ({ leaf, memo: captured.memos[i] })) });
  assert.equal(mine.length, 1, 'recipient 0 scans their lock from the driven airdrop');
  ok('runAirdrop: split settles first, denominations feed the locks, recipients scan the result');
}

console.log(`confidential-airdrop: all ${n} checks passed`);
