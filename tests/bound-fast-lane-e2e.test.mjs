// Binding a Bitcoin note and moving it to Ethereum by the fast lane, end to end with the real parts on each side:
//   Bitcoin  the bind (dapp/btc-bind.js) as a real commit/reveal pair, checked by the dapp's own tacit.validateOutpoint,
//            and each bound note opened again from the key and the chain alone
//   Ethereum the fast-lane spend the dapp builds (confidential-pool-ux.js buildFastlaneExitOp) over a Bitcoin pool root
//            holding those notes, run through the pinned settle guest (exec-fastlane) in execute mode, timed, with its
//            public values read back; and the same spend tampered three ways, each of which the guest refuses
//   HARNESS=contracts/sp1/confidential/harnesses/target/release node tests/bound-fast-lane-e2e.test.mjs
// HARNESS is a directory holding exec-fastlane (it writes the public values to PV_OUT). Without it the guest steps are
// skipped. Needs Node 22.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32, signSchnorr } from '../dapp/bulletproofs.js';
import { tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeBtcBind, openBoundNote, fastLaneNote, makePoolRoots, T_CXFER_BOUND } from '../dapp/btc-bind.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import { P, fetched, tacit, te, scalar, etchNote, validate } from './lib/btc-sim.mjs';

secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, secp.etc.concatBytes(...m));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const HARNESS = process.env.HARNESS ? resolve(process.env.HARNESS) : null;
const haveGuest = !!HARNESS && existsSync(join(HARNESS, 'exec-fastlane'));
const dir = mkdtempSync(join(tmpdir(), 'bound-fast-lane-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
// The validator here is the signet build, so the bind names the signet pool deployment (its chain binding is all the guest sees of it).
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'signet', fetchImpl: async () => { throw new Error('offline'); } });
const pool = ux.pool;
const dep = getConfidentialDeployment('signet');
const strip = (h) => String(h).replace(/^0x/, '');
const h0x = (b) => '0x' + bytesToHex(b);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
// The pool's chain binding, keccak(chainId ‖ pool) as the pool UX derives it.
const CHAIN_BINDING = h0x(keccak_256(hexToBytes(BigInt(dep.chainId).toString(16).padStart(64, '0') + strip(dep.pool).toLowerCase())));

// Ethereum, as the validator reads it: the pool's nullifier map (slot 70), with `spentOnEthereum` holding the nullifiers it has spent.
const spentOnEthereum = new Set();
const ethReads = [];
const offline = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const body = String(init?.body || '');
  if (init?.method !== 'POST' || !body.includes('eth_getStorageAt')) return offline(input, init);
  const req = JSON.parse(body);
  ethReads.push(req.params);
  const slotOf = (nu) => h0x(keccak_256(hexToBytes(strip(nu).padStart(64, '0') + (70).toString(16).padStart(64, '0'))));
  const hit = [...spentOnEthereum].some((nu) => slotOf(nu) === String(req.params[1]).toLowerCase());
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: word(hit ? 1 : 0) }), { headers: { 'content-type': 'application/json' } });
};

const kit = tacitKit(tacit);
const bind = makeBtcBind({ prims: P, kit, target: CHAIN_BINDING });
const own = P.p2wpkhScript(P.wallet.pub);
const fetchOf = (...ops) => { const m = new Map(ops.map((o) => [o.txid, o.esplora])); return async (id) => m.get(id) || null; };
const toEsplora = (pair, height = 330000) => ({
  txid: pair.revealTxid,
  esplora: {
    txid: pair.revealTxid, status: { confirmed: true, block_height: height },
    vin: pair.revealTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })),
    vout: pair.revealTx.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })),
  },
});
const coin = (tag, value) => ({ txid: bytesToHex(sha256(te('coin/' + tag))), vout: 0, value });

// The holder's note: 10,000 of an etched asset at the wallet's P2WPKH address, bound into 3,000 + 7,000.
const VALUE = 10_000n, SIZES = [3_000n, 7_000n];
const r0 = scalar('bind-note');
const etch = etchNote({ ticker: 'TP', value: VALUE, r: r0, script: own, signerD: scalar('etcher') });
const asset = etch.asset, assetHex = h0x(asset);
const pair = bind.bindTransfer({ asset, notes: [{ txid: etch.txid, vout: 0, value: 546, amount: VALUE, blinding: r0 }], sizes: SIZES, satsUtxos: [coin('bind-sats', 100_000)], feeRate: 2 });
const bindOp = toEsplora(pair);

test('the bind is one valid T_CXFER_BOUND transfer: each bound note at the Taproot address, named for the pool', async () => {
  const env = tacit.txOutputEnvelope(bindOp.esplora);
  assert.equal(env.opcode, T_CXFER_BOUND);
  assert.equal(h0x(env.payload.subarray(1, 33)), CHAIN_BINDING, 'the payload names the live pool deployment');
  const f = fetchOf(etch, bindOp);
  for (const vout of [0, 1]) {
    assert.deepEqual(await validate(f, pair.revealTxid, vout), { ok: true, reason: undefined }, `bound note ${vout} is valid`);
    assert.equal(bytesToHex(pair.revealTx.outputs[vout].script), bytesToHex(bind.fastScript), 'at P2TR(the wallet key)');
  }
  assert.equal(bytesToHex(bind.fastScript), '5120' + bytesToHex(P.wallet.xonly()), 'the authority key is the wallet key, untweaked');
  assert.ok(ethReads.length >= 2 && ethReads.every(([to]) => to === dep.pool.toLowerCase()), 'each bound note was checked in the pool it names');
  assert.deepEqual(fetched, [], 'nothing else read from the network');
});

test('each bound note opens again from the key and the chain alone, and nothing else opens', () => {
  for (const [vout, amount] of SIZES.entries()) {
    const o = openBoundNote({ tacit, priv: P.wallet.priv, pub: P.wallet.pub, tx: bindOp.esplora, vout });
    assert.ok(o, `note ${vout} opens`);
    assert.equal(o.amount, amount);
    assert.equal(o.blinding, pair.bound[vout].blinding);
    assert.equal('0x' + o.target, CHAIN_BINDING);
  }
  const other = bigintToBytes32(scalar('someone-else'));
  assert.equal(openBoundNote({ tacit, priv: other, pub: secp.getPublicKey(other, true), tx: bindOp.esplora, vout: 0 }), null, 'another key opens nothing');
  assert.equal(openBoundNote({ tacit, priv: P.wallet.priv, pub: P.wallet.pub, tx: etch.esplora, vout: 0 }), null, 'an unbound output is not a bound note');
});

test('the builder refuses sizes that do not add up, empty notes, or more than eight', () => {
  const note = { txid: etch.txid, vout: 0, value: 546, amount: VALUE, blinding: r0 };
  const go = (sizes) => () => bind.bindTransfer({ asset, notes: [note], sizes, satsUtxos: [coin('x', 100_000)], feeRate: 2 });
  assert.throws(go([1n, 2n]), /add up/);
  assert.throws(go([VALUE, 0n]), /hold something/);
  assert.throws(go(Array.from({ length: 9 }, () => 1n)), /at most 8/);
});

// The Bitcoin pool root the reflection would attest: other notes' leaves, then the two bound notes. The reflected spent
// set is a sorted linked list (an indexed Merkle tree) of nullifiers already spent on Bitcoin.
const authKey = h0x(P.wallet.xonly());
const authPriv = h0x(P.wallet.priv);
const bound = SIZES.map((value, vout) => {
  const blinding = word(pair.bound[vout].blinding);
  return { asset: assetHex, value: String(value), blinding, ...pool.commitXY(value, blinding), vout };
});
const tree = new pool.Tree();
for (let i = 0; i < 5; i++) tree.insert(h0x(keccak_256(te('other-leaf/' + i))));
bound.forEach((n) => { n.leafIndex = tree.insert(pool.btcNoteLeafBound(assetHex, n.cx, n.cy, authKey, CHAIN_BINDING)); });
const spendRoot = tree.root();
bound.forEach((n) => { n.path = tree.rootAndPath(n.leafIndex).path; n.nu = pool.nullifier(pool.btcNoteLeafBound(assetHex, n.cx, n.cy, authKey, CHAIN_BINDING)); });

const MAX = '0x' + 'ff'.repeat(32), ZERO = '0x' + '00'.repeat(32);
function spentSet(nullifiers) {
  const vals = [ZERO, ...nullifiers.map((n) => word(BigInt(n)))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const t = new pool.Tree();
  const rows = vals.map((v, i) => ({ value: v, next: vals[i + 1] ?? MAX }));
  rows.forEach((r) => { r.index = t.insert(pool.imtLeaf(r.value, r.next)); });
  const root = t.root();
  const lowFor = (nu) => {
    const r = rows.filter((x) => BigInt(x.value) < BigInt(nu)).at(-1);
    return { value: r.value, next: r.next, index: r.index, path: t.rootAndPath(r.index).path };
  };
  return { root, lowFor };
}
const others = Array.from({ length: 6 }, (_, i) => h0x(keccak_256(te('spent/' + i))));
const spent = spentSet(others);
bound.forEach((n) => { n.low = spent.lowFor(n.nu); });

// The relay's answer, as POST /reflection/note-witness builds it from the persisted reflection state (the notes' leaves
// and the spent set's links, in the production accumulator), and the pool's own roots read from its storage.
const liveSpent = pool.makeImtAccumulator();
others.forEach((nu) => liveSpent.insert(nu));
const witnessFor = async ({ leaves, nullifiers }) => {
  const witnesses = {}, unspent = {};
  for (const leaf of leaves) {
    const n = bound.find((b) => pool.btcNoteLeafBound(assetHex, b.cx, b.cy, authKey, CHAIN_BINDING) === leaf);
    witnesses[leaf] = n ? { leafIndex: n.leafIndex, path: n.path } : null;
  }
  for (const nu of nullifiers) {
    if (liveSpent.contains(nu)) { unspent[nu] = { spent: true }; continue; }
    const w = liveSpent.nonMembershipWitness(nu);
    unspent[nu] = { value: w.lowValue, next: w.lowNext, index: w.lowIndex, path: w.path };
  }
  return { root: spendRoot, spentRoot: liveSpent.root(), witnesses, unspent };
};
const poolStorage = new Map();
const roots = makePoolRoots({ pool: dep.pool, keccak256: keccak_256, getStorageAt: async (_, slot) => poolStorage.get(slot) ?? word(0) });
const knownSlot = (root) => h0x(keccak_256(hexToBytes(strip(root).padStart(64, '0') + (78).toString(16).padStart(64, '0'))));
poolStorage.set(knownSlot(spendRoot), word(1));
poolStorage.set('0x' + (79).toString(16).padStart(64, '0'), liveSpent.root());

const walletPriv = '0x' + bytesToHex(sha256(te('eth-side-wallet')));
const FEE = 25n;
const lane = await fastLaneNote({ pool, roots, witnessFor, note: { asset: assetHex, amount: SIZES[1], blinding: pair.bound[1].blinding }, authKey, chainBinding: CHAIN_BINDING });
const exit = lane.ready ? ux.buildFastlaneExitOp({ walletPriv, notes: [lane.input], authPriv, spendRoot: lane.spendRoot, bitcoinSpentRoot: lane.bitcoinSpentRoot, fee: FEE }) : null;

test('a bound note in the reflected root and absent from the spent set is ready; the relay\'s roots are checked against the pool\'s', async () => {
  assert.equal(lane.ready, true, JSON.stringify(lane));
  assert.equal(lane.nullifier, bound[1].nu);
  assert.equal(lane.bitcoinSpentRoot, liveSpent.root());
  const before = poolStorage.get('0x' + (79).toString(16).padStart(64, '0'));
  poolStorage.set('0x' + (79).toString(16).padStart(64, '0'), word(7));
  assert.equal((await fastLaneNote({ pool, roots, witnessFor, note: { asset: assetHex, amount: SIZES[1], blinding: pair.bound[1].blinding }, authKey, chainBinding: CHAIN_BINDING })).why, 'syncing', 'a spent root the pool does not hold');
  poolStorage.set('0x' + (79).toString(16).padStart(64, '0'), before);
  const notYet = await fastLaneNote({ pool, roots, witnessFor, note: { asset: assetHex, amount: 1n, blinding: 5n }, authKey, chainBinding: CHAIN_BINDING });
  assert.equal(notYet.why, 'reflecting', 'a note the reflection has not folded');
  liveSpent.insert(bound[0].nu);
  const gone = await fastLaneNote({ pool, roots, witnessFor, note: { asset: assetHex, amount: SIZES[0], blinding: pair.bound[0].blinding }, authKey, chainBinding: CHAIN_BINDING });
  assert.equal(gone.why, 'spent', 'a note the reflection saw spent on Bitcoin');
  // a relay that answers membership but not yet the spent set (an earlier deploy) leaves the note waiting, never called spent
  const older = async (body) => { const w = await witnessFor(body); delete w.unspent; delete w.spentRoot; return w; };
  assert.equal((await fastLaneNote({ pool, roots, witnessFor: older, note: { asset: assetHex, amount: SIZES[1], blinding: pair.bound[1].blinding }, authKey, chainBinding: CHAIN_BINDING })).why, 'syncing');
});

test('the dapp builds the fast-lane spend of one bound note: signed by the wallet key, the rest recoverable on Ethereum', () => {
  const t = exit.op.transfer;
  assert.equal(exit.op.chainBinding, CHAIN_BINDING, 'the spend is for the same deployment the bind named');
  assert.equal(t.inputs.length, 1);
  assert.equal(t.inputs[0].owner, authKey);
  assert.equal(exit.amount, SIZES[1] - FEE);
  const opened = ux.indexer._memo.openMemo(walletPriv, exit.leaves[0], exit.memos[0]);
  assert.ok(opened && opened.value === SIZES[1] - FEE, 'the pool note opens from its memo');
  // A note already in the reflected spent set (spent on Bitcoin) has no non-membership witness, so nothing is built.
  const gone = spentSet([...others, bound[1].nu]);
  assert.throws(() => ux.buildFastlaneExitOp({ walletPriv, notes: [{ ...bound[1], low: gone.lowFor(bound[1].nu) }], authPriv, spendRoot, bitcoinSpentRoot: gone.root, fee: FEE }), /non-membership/);
  assert.throws(() => ux.buildFastlaneExitOp({ walletPriv, notes: [bound[1]], authPriv: word(scalar('not-the-key')), spendRoot, bitcoinSpentRoot: spent.root, fee: FEE }), /not a member/);
});

test('once the pool has spent the bound note, it is no longer a note on Bitcoin; its sibling still is', async () => {
  spentOnEthereum.add(bound[1].nu);
  tacit.clearValidatorCaches();
  try {
    const f = fetchOf(etch, bindOp);
    assert.equal((await validate(f, pair.revealTxid, 1)).ok, false, 'the moved note');
    assert.deepEqual(await validate(f, pair.revealTxid, 0), { ok: true, reason: undefined }, 'the note left on Bitcoin');
  } finally { spentOnEthereum.clear(); tacit.clearValidatorCaches(); }
});

// One execute of the pinned settle guest. Accepted means public values were committed and nothing panicked.
function runGuest(op, memos) {
  const tag = Math.random().toString(36).slice(2);
  const opFile = join(dir, tag + '.json'), pvFile = join(dir, tag + '.pv');
  const memoHashes = memos.map((m) => h0x(keccak_256(hexToBytes(strip(m)))));
  writeFileSync(opFile, JSON.stringify({ ...op, memoHashes }));
  const t0 = Date.now();
  const r = spawnSync(join(HARNESS, 'exec-fastlane'), [], { cwd: dir, env: { ...process.env, MODE: 'execute', OP_FILE: opFile, PV_OUT: pvFile, RUST_LOG: 'error' }, encoding: 'utf8', timeout: 600_000 });
  const ms = Date.now() - t0;
  const out = (r.stdout || '') + (r.stderr || '');
  const pvBytes = Number((out.match(/pv_bytes=(\d+)/) || [])[1] || 0);
  const cycles = Number((out.match(/cycles=(\d+)/) || [])[1] || 0);
  const ok = r.status === 0 && pvBytes > 0 && !/panicked/.test(out);
  const panic = (out.match(/panicked[^\n]*\n?[^\n]*/) || [''])[0];
  return { ok, pv: ok && existsSync(pvFile) ? readFileSync(pvFile, 'utf8').trim() : null, ms, cycles, panic, out };
}

test('the pinned guest accepts the spend: the bound note is consumed against the Bitcoin root, the pool note is created', () => {
  const r = runGuest(exit.op, exit.memos);
  assert.ok(r.ok, 'guest accepted:\n' + r.out.slice(-1500));
  const pv = r.pv.toLowerCase();
  for (const [what, h] of [['chain binding', CHAIN_BINDING], ['Bitcoin pool root', spendRoot], ['reflected spent root', lane.bitcoinSpentRoot], ['the bound note nullifier', bound[1].nu], ['the new pool leaf', exit.leaves[0]]]) {
    assert.ok(pv.includes(strip(h).toLowerCase()), `public values carry ${what}`);
  }
  console.log(`    guest execute: ${(r.ms / 1000).toFixed(1)} s wall (setup + execute), ${(r.cycles / 1e6).toFixed(1)} M cycles`);
});

test('the guest refuses the spend tampered: another key\'s signature, a note spent on Bitcoin, another deployment', () => {
  const t = exit.op.transfer;
  // 1. A signature by another key over the same message.
  const forged = structuredClone(exit.op);
  const lf = pool.btcNoteLeafBound(assetHex, t.inputs[0].cx, t.inputs[0].cy, authKey, CHAIN_BINDING);
  const OP_ID = '0x' + Buffer.from('tacit.op.transfer'.padEnd(32, '\0')).toString('hex');
  const msg = pool.btcNoteSpendMsg(CHAIN_BINDING, OP_ID, lf, pool.nullifier(lf), exit.leaves, FEE, 0n);
  forged.transfer.inputs[0].sig = h0x(signSchnorr(hexToBytes(strip(msg)), bigintToBytes32(scalar("thief"))));
  // 2. The reflected spent set holds the note (it was spent on Bitcoin first): the only low leaf left brackets nothing.
  const gone = spentSet([...others, bound[1].nu]);
  const respent = structuredClone(exit.op);
  respent.bitcoinSpentRoot = gone.root;
  const below = gone.lowFor(bound[1].nu);
  respent.transfer.inputs[0].low = { ...below, index: Number(below.index) };
  // 3. The same note and signature presented to another deployment.
  const elsewhere = structuredClone(exit.op);
  elsewhere.chainBinding = h0x(keccak_256(te('another-pool')));
  for (const [what, op] of [['a forged signature', forged], ['a note spent on Bitcoin', respent], ['another deployment', elsewhere]]) {
    const r = runGuest(op, exit.memos);
    assert.ok(!r.ok, `the guest refuses ${what}`);
    console.log(`    refused ${what}: ${r.panic.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
});

let failed = 0, skipped = 0;
for (const [name, fn] of tests) {
  const needsGuest = /pinned guest|guest refuses/.test(name);
  if (needsGuest && !haveGuest) { skipped++; console.log(`  - ${name} (skipped: HARNESS has no exec-fastlane)`); continue; }
  try { await fn(); console.log(`  ok ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n    ${e.stack?.split('\n').slice(0, 4).join('\n    ')}`); }
}
console.log(`${tests.length - failed - skipped} ok, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
