// Outputs a wallet mints for itself (change, a self-send's received note, LP shares, swap outputs, released collateral, claim and
// refund notes, farm rewards and unbonds) take their nullifier key and blinding from the wallet key and a public anchor of the
// settle. These tests check the derivation (deterministic, collision-free, key-bound), that the assemblers use it and keep
// recipient-owned material random, and that recover() finds each kind of output again from chain data with no memo.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';
import { makeConfidentialRecovery, deriveOutputKeys, OUTPUT_ROLES, roundAmounts } from '../dapp/confidential-recovery.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { bppGens, G as BPP_G } from '../dapp/bulletproofs-plus.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
const { encodeAbiParameters } = await import('../worker-relay/node_modules/viem/_esm/index.js');

const CFG = getConfidentialDeployment('mainnet');
const FARM = CFG.farm;
const MANAGER = FARM.manager.toLowerCase();
const CURVE_N = secp.CURVE.n;
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const evLog = makeConfidentialEvmLog({ keccak256: keccak_256 });
const walletPriv = '0x' + '7a'.repeat(32);
const otherPriv = '0x' + '7b'.repeat(32);
const tx = (n) => '0x' + String(n).padStart(64, '0');
const keyDeps = { hmac, sha256: nobleSha256, curveOrder: CURVE_N };
const derive = (priv, anchor, role, index = 0) => deriveOutputKeys(keyDeps, priv, anchor, role, index);
const noFlags = { cbtc: false, farm: false, locks: false, cdp: false };

function mkUx(handler = async () => '0x', extra = {}) {
  const fetchImpl = async (url, o) => {
    const b = o && o.body ? JSON.parse(o.body) : null;
    if (b && b.method) {
      let result;
      try { result = await handler(b.method, b.params, b); } catch (e) { return { ok: true, status: 200, json: async () => ({ error: { message: e.message } }), text: async () => '' }; }
      return { ok: true, status: 200, json: async () => ({ result }), text: async () => JSON.stringify({ result }) };
    }
    if (extra.http) return extra.http(url, b);
    throw new Error('no network');
  };
  return makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl });
}

const leavesEv = (first, leaves, memos, txHash) => ({ type: 'LeavesInserted', firstLeafIndex: first, leaves, memos: memos || leaves.map(() => '0x'), txHash });
const nullifiersEv = (nullifiers, txHash) => ({ type: 'NullifiersSpent', nullifiers, txHash });
const sealTo = (ux, priv, n, seed = 5n) => ux.memo.encodeMemo(ux.memo.sealMemo(ux.identity(priv).pubHex, n, () => seed));

// A spendable note owned by `priv`: the wrap derivation for (asset, index), in a shared tree so the assemblers' membership
// self-check passes.
function ownNote(ux, priv, asset, index, value, tree = new ux.pool.Tree()) {
  const id = ux.identity(priv);
  const dn = ux.pool.deriveNote(id.priv, asset, index);
  const blinding = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
  const owner = ux.pool.nkToOwner(dn.secret);
  const c = ux.pool.commitXY(BigInt(value), blinding);
  const leaf = ux.pool.leaf(asset, c.cx, c.cy, owner);
  const leafIndex = tree.insert(leaf);
  return { asset, value: BigInt(value), blinding, secret: dn.secret, owner, ...c, leaf, leafIndex, tree };
}
const withPath = (n) => ({ ...n, path: n.tree.rootAndPath(n.leafIndex).path, root: n.tree.root() });
const nuOf = (ux, n) => ux.pool.nativeNu(n.owner, n.secret, n.leaf);
// The leaf an assembler mints for (anchor, role, index) holding `value` of `asset`.
const derivedLeaf = (ux, priv, anchor, asset, role, index, value) => {
  const k = derive(priv, anchor, role, index);
  const c = ux.pool.commitXY(BigInt(value), k.blindingHex);
  return ux.pool.leaf(asset, c.cx, c.cy, ux.pool.nkToOwner(k.nk));
};

// ── settle public values, only the fields the walks read ──
function pvBytes(fields) {
  const N = 35, head = new Array(N).fill(w(0)); let tail = '';
  for (const [i, t] of Object.entries(fields)) { head[i] = w(N * 32 + tail.length / 2); tail += t; }
  return '0x' + w(32) + head.join('') + tail;
}
const staticArr = (n, words) => w(n) + words.join('');
const settleInput = (pv) => '0x717fd7f2' + encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes[]' }], [pv, '0x', []]).slice(2);
const addrWord = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const feesField = (asset, fee) => staticArr(1, [w(asset), w(fee)]);
const swapWords = (s) => [s.poolId, s.aPre, s.bPre, s.aPost, s.bPost, s.cutA || 0n, s.cutB || 0n].map(w);
const lpWords = (l) => [l.poolId, l.aPre, l.bPre, l.sharesPre, l.aPost, l.bPost, l.sharesPost].map(w);
function mintsTail(mints) {
  const elems = mints.map((m) => addrWord(m.controller) + w(m.debtAsset) + w(m.debtValue) + w(m.positionLeaf) + w(m.rateSnapshot) + w(224) + w(m.owner)
    + w(m.legs.length) + m.legs.map((l) => w(l.asset) + w(l.value)).join(''));
  let off = mints.length * 32; const heads = [];
  for (const e of elems) { heads.push(w(off)); off += e.length / 2; }
  return w(mints.length) + heads.join('') + elems.join('');
}
const inputsOf = (map) => async (method, params) => (method === 'eth_getTransactionByHash' && map[params[0]] ? { input: settleInput(map[params[0]]), to: CFG.pool } : undefined);

// ── the derivation ──
test('deriveOutputKeys: deterministic, in range, key-bound, and collision-free across roles, indexes and anchors', () => {
  const anchors = ['0x' + '11'.repeat(32), '0x' + '12'.repeat(32), '0x' + '00'.repeat(31) + '01'];
  const seen = new Set();
  let count = 0;
  for (const anchor of anchors) for (const role of OUTPUT_ROLES) for (let i = 0; i < 8; i++) {
    const a = derive(walletPriv, anchor, role, i), b = derive(walletPriv, anchor, role, i);
    assert.deepEqual(a, b, 'the same triple derives the same output');
    assert.ok(BigInt(a.nk) > 0n && BigInt(a.nk) < CURVE_N && a.blinding > 0n && a.blinding < CURVE_N, 'nk and blinding are non-zero scalars');
    assert.equal(a.blindingHex, '0x' + a.blinding.toString(16).padStart(64, '0'));
    seen.add(a.nk); seen.add(a.blindingHex); count += 2;
  }
  assert.equal(seen.size, count, 'no two (anchor, role, index, nk|blinding) share a value');
  const base = derive(walletPriv, anchors[0], 'change', 0);
  assert.notEqual(derive(otherPriv, anchors[0], 'change', 0).nk, base.nk, 'another key derives other outputs');
  assert.equal(derive(Uint8Array.from(Buffer.from(walletPriv.slice(2), 'hex')), anchors[0], 'change', 0).nk, base.nk, 'bytes and hex forms of one key agree');
  assert.throws(() => derive(walletPriv, anchors[0], 'nonsense', 0), /unknown role/);
  assert.throws(() => derive(walletPriv, '0xzz', 'change', 0), /32-byte hex/);
  assert.throws(() => derive(walletPriv, anchors[0], 'change', -1), /uint32/);
  assert.equal(mkUx().deriveOutput(walletPriv, anchors[0], 'change', 0).nk, base.nk, 'the ux entry point is the same function');
});

test('roundAmounts: m x 10^k for m below 100 (the shape every guest-accepted fee has)', () => {
  const r = new Set(roundAmounts(10n ** 6n));
  for (const v of [1n, 99n, 100n, 4000n, 990000n, 1000000n]) assert.ok(r.has(v), String(v));
  for (const v of [101n, 1001n, 123n]) assert.ok(!r.has(v), String(v));
});

// ── the assemblers ──
function transferScene(ux, value = 90000n) {
  const ceth = ux.assetByTicker.cETH;
  const parent = withPath(ownNote(ux, walletPriv, ceth.assetId, 0, value));
  return { ceth, parent, pub: ux.identity(walletPriv).pubHex };
}

test('buildTransferOp: outputs derive from the wallet key and the first spent nullifier; memos still seal under fresh ephemerals', () => {
  const ux = mkUx();
  const { parent, pub } = transferScene(ux);
  const anchor = nuOf(ux, parent);
  const a = ux.buildTransferOp({ walletPriv, notes: [parent], recipientPubHex: pub, amount: 40000n, fee: 1000n });
  const b = ux.buildTransferOp({ walletPriv, notes: [parent], recipientPubHex: pub, amount: 40000n, fee: 1000n });
  const send = derive(walletPriv, anchor, 'send', 0), change = derive(walletPriv, anchor, 'change', 0);
  assert.equal(a.outputs[0].secret, send.nk); assert.equal(a.outputs[0].blinding, send.blindingHex);
  assert.equal(a.outputs[1].secret, change.nk); assert.equal(a.outputs[1].blinding, change.blindingHex);
  assert.deepEqual(a.leaves, b.leaves, 'a rebuild of the same op mints the same leaves');
  assert.notEqual(a.memos[0], b.memos[0], 'the memo ephemeral is fresh per build, so memos are not reproducible');
  assert.notEqual(a.outputs[0].secret, a.outputs[1].secret);
  for (const o of a.outputs) assert.equal(ux.pool.nkToOwner(o.secret).toLowerCase(), String(o.owner).toLowerCase(), 'every output is spendable with its own nk');
  const second = withPath(ownNote(ux, walletPriv, parent.asset, 1, 90000n));
  const c = ux.buildTransferOp({ walletPriv, notes: [second], recipientPubHex: pub, amount: 40000n, fee: 1000n });
  assert.notEqual(c.outputs[0].secret, a.outputs[0].secret, 'another spent note gives other outputs');
  const d = ux.buildTransferOp({ walletPriv, notes: [parent], recipientPubHex: pub, amount: 30000n, fee: 0n });
  assert.equal(d.outputs[0].secret, send.nk, 'the keys depend on the anchor and role, not on the amounts');
});

test('recipient-owned material stays random: stealth locks are built from fresh keys each time, and a third-party transfer is refused', async () => {
  const ux = mkUx();
  const { parent } = transferScene(ux, 50000n);
  const stranger = ux.identity(otherPriv).pubHex;
  assert.throws(() => ux.buildTransferOp({ walletPriv, notes: [parent], recipientPubHex: stranger, amount: 40000n }), /third party|stealth/i);
  const built = [];
  for (let i = 0; i < 2; i++) {
    await ux.stealthSend({ walletPriv, recipientPubHex: stranger, notes: [parent], amount: 50000n, onBuilt: (b) => built.push(b) }).catch(() => {});
  }
  assert.equal(built.length, 2, 'onBuilt fires before dispatch');
  assert.notEqual(built[0].lockLeaf, built[1].lockLeaf, 'the lock differs between builds of the same send');
  assert.notEqual(built[0].refundPriv, built[1].refundPriv);
  assert.notEqual(built[0].lBlinding, built[1].lBlinding);
  assert.notEqual(built[0].memo, built[1].memo);
});

// ── recover(): outputs found from a spent note and its settle ──
test('recover: a transfer\'s received note and change come back with no memo from the spent note\'s nullifier and the settle', async () => {
  const ux0 = mkUx();
  const { ceth, parent, pub } = transferScene(ux0);
  const FEE = 1000n;
  const b = ux0.buildTransferOp({ walletPriv, notes: [parent], recipientPubHex: pub, amount: 40000n, fee: FEE });
  const T = tx(11);
  const events = [leavesEv(0, [parent.leaf], [sealTo(ux0, walletPriv, parent)], tx(10)), nullifiersEv([nuOf(ux0, parent)], T), leavesEv(1, b.leaves, null, T)];
  const pv = pvBytes({ 3: staticArr(1, [w(nuOf(ux0, parent))]), 7: feesField(ceth.assetId, FEE) });
  const ux = mkUx(inputsOf({ [T]: pv }));
  const r = await ux.recover({ walletPriv, events, ...noFlags, deep: true });
  assert.equal(r.notes.length, 2);
  const byRole = Object.fromEntries(r.notes.map((n) => [n.role, n]));
  assert.equal(BigInt(byRole.send.value), 40000n); assert.equal(BigInt(byRole.change.value), 90000n - 40000n - FEE);
  for (const n of r.notes) {
    assert.equal(n.source, 'derived'); assert.equal(n.asset, ceth.assetId);
    assert.equal(ux.pool.nkToOwner(n.secret).toLowerCase(), n.owner.toLowerCase());
    assert.ok(n.path && n.path.length === 32 && n.root, 'ready to spend: carries its membership path');
  }
  assert.equal(byRole.send.leaf, b.leaves[0]); assert.equal(byRole.change.leaf, b.leaves[1]);
  assert.equal(r.diagnostics.notes.viaDerivedOutputs, 2);
  assert.equal(r.diagnostics.notes.emptyMemoLeavesNotAttributed, 0);
  const shallow = await ux.recover({ walletPriv, events, ...noFlags, deep: false });
  assert.equal(shallow.notes.length, 0); assert.equal(shallow.diagnostics.notes.emptyMemoLeavesNotAttributed, 2);
  const other = await ux.recover({ walletPriv: otherPriv, events, ...noFlags, deep: true });
  assert.equal(other.notes.length, 0, 'another key finds nothing in the same events');
});

test('recover: a derived note that is later spent is followed, so a chain of self-sends comes back end to end', async () => {
  const ux0 = mkUx();
  const { parent, pub } = transferScene(ux0);
  const b1 = ux0.buildTransferOp({ walletPriv, notes: [parent], recipientPubHex: pub, amount: 40000n, fee: 0n });
  // the send output of the first transfer is spent by a second one
  const tree = new ux0.pool.Tree();
  tree.insert(parent.leaf);
  const sendIdx = tree.insert(b1.leaves[0]); tree.insert(b1.leaves[1]);
  const o = b1.outputs[0];
  const sendNote = { asset: parent.asset, value: 40000n, blinding: o.blinding, secret: o.secret, owner: o.owner, cx: o.cx, cy: o.cy, leaf: b1.leaves[0], leafIndex: sendIdx, tree };
  const b2 = ux0.buildTransferOp({ walletPriv, notes: [withPath(sendNote)], recipientPubHex: pub, amount: 15000n, fee: 0n });
  const T1 = tx(11), T2 = tx(12);
  const events = [
    leavesEv(0, [parent.leaf], [sealTo(ux0, walletPriv, parent)], tx(10)), nullifiersEv([nuOf(ux0, parent)], T1), leavesEv(1, b1.leaves, null, T1),
    nullifiersEv([nuOf(ux0, sendNote)], T2), leavesEv(3, b2.leaves, null, T2),
  ];
  const ux = mkUx(inputsOf({ [T1]: pvBytes({ 3: staticArr(1, [w(nuOf(ux0, parent))]) }), [T2]: pvBytes({ 3: staticArr(1, [w(nuOf(ux0, sendNote))]) }) }));
  const r = await ux.recover({ walletPriv, events, ...noFlags, deep: true });
  assert.deepEqual(r.notes.map((n) => BigInt(n.value)).sort((x, y) => (x < y ? -1 : 1)), [15000n, 25000n, 50000n]);
  assert.equal(r.diagnostics.notes.emptyMemoLeavesNotAttributed, 0);
});

test('recover: a self-send of an amount that is not a round number is found through its memo; the derivation alone cannot know the split', async () => {
  const ux0 = mkUx();
  const { parent, pub } = transferScene(ux0);
  const b = ux0.buildTransferOp({ walletPriv, notes: [parent], recipientPubHex: pub, amount: 41234n, fee: 0n });
  const T = tx(11);
  const pv = pvBytes({ 3: staticArr(1, [w(nuOf(ux0, parent))]) });
  const head = [leavesEv(0, [parent.leaf], [sealTo(ux0, walletPriv, parent)], tx(10)), nullifiersEv([nuOf(ux0, parent)], T)];
  const ux = mkUx(inputsOf({ [T]: pv }));
  const r0 = await ux.recover({ walletPriv, events: [...head, leavesEv(1, b.leaves, null, T)], ...noFlags, deep: true });
  assert.equal(r0.notes.length, 0); assert.equal(r0.diagnostics.notes.emptyMemoLeavesNotAttributed, 2, 'reported, not guessed');
  const r1 = await ux.recover({ walletPriv, events: [...head, leavesEv(1, b.leaves, b.memos, T)], ...noFlags, deep: true });
  assert.deepEqual(r1.notes.map((n) => BigInt(n.value)).sort((x, y) => (x < y ? -1 : 1)), [41234n, 90000n - 41234n].sort((x, y) => (x < y ? -1 : 1)));
  assert.ok(r1.notes.every((n) => n.source === undefined), 'the memo channel is unchanged');
});

test('recover: wrap-and-send outputs derive from the consumed deposit id; the settle is found from the deposit\'s own transaction or a later settle', async () => {
  const ux0 = mkUx();
  const ceth = ux0.assetByTicker.cETH;
  const scale = BigInt(ceth.unitScale);
  const pub = ux0.identity(walletPriv).pubHex;
  const b = ux0.buildWrapTransferOp({ walletPriv, amountWei: (90000n * scale).toString(), ticker: 'cETH', recipientPubHex: pub, amount: 40000n, fee: 0n, index: 3 });
  assert.equal(b.outputs[0].secret, derive(walletPriv, b.depositId, 'send', 0).nk);
  assert.equal(b.outputs[1].secret, derive(walletPriv, b.depositId, 'change', 0).nk);
  const T = tx(31);
  const wrapEv = { type: 'Wrap', depositId: b.depositId, assetId: ceth.assetId, amount: 90000n * scale, txHash: T };
  const pv = pvBytes({ 5: staticArr(1, [w(b.depositId)]) });
  const r = await mkUx(inputsOf({ [T]: pv })).recover({ walletPriv, events: [wrapEv, leavesEv(0, b.leaves, null, T)], ...noFlags, deep: true });
  assert.deepEqual(r.notes.map((n) => [n.role, BigInt(n.value)]), [['send', 40000n], ['change', 50000n]]);
  assert.equal(r.diagnostics.derived.depositsLocated, 1);
  const T2 = tx(32);
  const later = [wrapEv, leavesEv(0, [tx(77)], null, tx(30)), leavesEv(1, b.leaves, null, T2)];
  const r2 = await mkUx(inputsOf({ [tx(30)]: pvBytes({}), [T2]: pv })).recover({ walletPriv, events: later, ...noFlags, deep: true });
  assert.equal(r2.notes.length, 2, 'a fused op settled later is located by reading the settles after the Wrap event');
});

// Two pool assets in canonical (ascending) pair order.
const sortedAssets = () => ['cETH', 'cUSD'].map((t) => mkUx().assetByTicker[t].assetId).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

test('recover: an LP add (share and both change notes) is derived from the first spent note and the pool\'s reserve and share changes', async () => {
  const ux0 = mkUx();
  const [assetA, assetB] = sortedAssets();
  const tree = new ux0.pool.Tree();
  const nA = ownNote(ux0, walletPriv, assetA, 0, 1000n, tree), nB = ownNote(ux0, walletPriv, assetB, 0, 1000n, tree);
  const pid = ux0.pool.evmPoolId(assetA, assetB, 30), lpAsset = ux0.pool.evmLpShareId(pid);
  const anchor = nuOf(ux0, nA);
  const dA = 600n, dB = 800n, dShares = 700n;
  const leaves = [derivedLeaf(ux0, walletPriv, anchor, lpAsset, 'lpShare', 0, dShares), derivedLeaf(ux0, walletPriv, anchor, assetA, 'change', 0, 1000n - dA), derivedLeaf(ux0, walletPriv, anchor, assetB, 'change', 1, 1000n - dB)];
  const T = tx(41);
  const liquidity = staticArr(1, lpWords({ poolId: pid, aPre: 10000n, bPre: 10000n, sharesPre: 10000n, aPost: 10000n + dA, bPost: 10000n + dB, sharesPost: 10000n + dShares }));
  const pv = pvBytes({ 3: staticArr(2, [w(nuOf(ux0, nA)), w(nuOf(ux0, nB))]), 14: liquidity });
  const events = [leavesEv(0, [nA.leaf, nB.leaf], [sealTo(ux0, walletPriv, nA), sealTo(ux0, walletPriv, nB)], tx(40)), nullifiersEv([nuOf(ux0, nA), nuOf(ux0, nB)], T), leavesEv(2, leaves, null, T)];
  const r = await mkUx(inputsOf({ [T]: pv })).recover({ walletPriv, events, ...noFlags, deep: true });
  const got = Object.fromEntries(r.notes.map((n) => [`${n.role}${n.roleIndex}`, n]));
  assert.equal(BigInt(got.lpShare0.value), dShares); assert.equal(got.lpShare0.asset, lpAsset);
  assert.equal(BigInt(got.change0.value), 400n); assert.equal(got.change0.asset, assetA);
  assert.equal(BigInt(got.change1.value), 200n); assert.equal(got.change1.asset, assetB);
});

test('recover: an LP removal\'s two outputs and a route\'s output and change are derived from the settle\'s public reserve changes', async () => {
  const ux0 = mkUx();
  const [assetA, assetB] = sortedAssets();
  const pid = ux0.pool.evmPoolId(assetA, assetB, 30), lpAsset = ux0.pool.evmLpShareId(pid);
  const tree = new ux0.pool.Tree();
  const share = ownNote(ux0, walletPriv, lpAsset, 0, 1000n, tree);
  const rIn = ownNote(ux0, walletPriv, assetA, 1, 5000n, tree);
  // remove: 1000 shares of 10000 -> 1000 A and 1000 B, relay fee 20 taken from A
  const rem = [derivedLeaf(ux0, walletPriv, nuOf(ux0, share), assetA, 'lpOut', 0, 980n), derivedLeaf(ux0, walletPriv, nuOf(ux0, share), assetB, 'lpOut', 1, 1000n)];
  const T1 = tx(51);
  const pv1 = pvBytes({ 3: staticArr(1, [w(nuOf(ux0, share))]), 7: feesField(assetA, 20n), 14: staticArr(1, lpWords({ poolId: pid, aPre: 10000n, bPre: 10000n, sharesPre: 10000n, aPost: 9000n, bPost: 9000n, sharesPost: 9000n })) });
  // route: spend 2000 of a 5000 A note, receive 1800 B, change 3000 A
  const rt = [derivedLeaf(ux0, walletPriv, nuOf(ux0, rIn), assetB, 'swapOut', 0, 1800n), derivedLeaf(ux0, walletPriv, nuOf(ux0, rIn), assetA, 'change', 0, 3000n)];
  const T2 = tx(52);
  const pv2 = pvBytes({ 3: staticArr(1, [w(nuOf(ux0, rIn))]), 13: staticArr(1, swapWords({ poolId: pid, aPre: 10000n, bPre: 10000n, aPost: 12000n, bPost: 8200n })) });
  const events = [
    leavesEv(0, [share.leaf, rIn.leaf], [sealTo(ux0, walletPriv, share), sealTo(ux0, walletPriv, rIn)], tx(50)),
    nullifiersEv([nuOf(ux0, share)], T1), leavesEv(2, rem, null, T1),
    nullifiersEv([nuOf(ux0, rIn)], T2), leavesEv(4, rt, null, T2),
  ];
  const r = await mkUx(inputsOf({ [T1]: pv1, [T2]: pv2 })).recover({ walletPriv, events, ...noFlags, deep: true });
  const vals = Object.fromEntries(r.notes.map((n) => [`${n.role}${n.roleIndex}:${n.asset === assetA ? 'A' : 'B'}`, BigInt(n.value)]));
  assert.deepEqual(vals, { 'lpOut0:A': 980n, 'lpOut1:B': 1000n, 'swapOut0:B': 1800n, 'change0:A': 3000n });
});

test('recover: a CDP debt note is derived from the first collateral nullifier and the published debt', async () => {
  const ux0 = mkUx();
  const ceth = ux0.assetByTicker.cETH;
  const tree = new ux0.pool.Tree();
  const coll = ownNote(ux0, walletPriv, ceth.assetId, 0, 7000n, tree);
  const debtAsset = '0x' + 'd7'.repeat(32);
  const debtLeaf = derivedLeaf(ux0, walletPriv, nuOf(ux0, coll), debtAsset, 'cdpDebt', 0, 500n);
  const T = tx(61);
  const mint = { controller: CFG.collateralEngine, debtAsset, debtValue: 500n, positionLeaf: '0x' + '9c'.repeat(32), rateSnapshot: 0n, owner: '0x' + '4e'.repeat(32), legs: [{ asset: ceth.assetId, value: 7000n }] };
  const pv = pvBytes({ 3: staticArr(1, [w(nuOf(ux0, coll))]), 22: mintsTail([mint]) });
  const events = [leavesEv(0, [coll.leaf], [sealTo(ux0, walletPriv, coll)], tx(60)), nullifiersEv([nuOf(ux0, coll)], T), leavesEv(1, [debtLeaf], null, T)];
  const r = await mkUx(inputsOf({ [T]: pv })).recover({ walletPriv, events, ...noFlags, deep: true });
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].role, 'cdpDebt'); assert.equal(BigInt(r.notes[0].value), 500n); assert.equal(r.notes[0].asset, debtAsset);
});

// ── outputs whose anchor is a receipt, a lock or a closed position ──
test('walkDirectOutputs: claim, refund, unbond, harvest and released-collateral outputs match tree leaves under fee candidates', () => {
  const ux = mkUx();
  const R = makeConfidentialRecovery({
    pool: ux.pool, memo: ux.memo, keccak256: keccak_256, secp, hmac, sha256: nobleSha256, curveOrder: CURVE_N, lockScan: ux.lockScan, airdrop: null,
    cdp: makeConfidentialCdp({ keccak256: keccak_256, pool: ux.pool, signSchnorr }), bpp: { H: bppGens().H, G: BPP_G },
  });
  const asset = '0x' + 'e1'.repeat(32);
  const lockNu = '0x' + '31'.repeat(32), receipt = '0x' + '32'.repeat(32), posNu = '0x' + '33'.repeat(32);
  const wants = [
    ['claim', 0, lockNu, 9500n],                  // a 10000 lock claimed under a fee of 500
    ['refund', 0, lockNu, 10000n],
    ['unbond', 0, receipt, 4000n],
    ['harvest', 0, receipt, 2499999000n],         // 2500000000 less a fee of 1000
    ['harvest', 1, receipt, 700n],
    ['cdpRelease', 0, posNu, 6900n], ['cdpRelease', 1, posNu, 42n],
  ];
  const inTree = new Set([...wants.map(([role, i, anchor, v]) => derivedLeaf(ux, walletPriv, anchor, asset, role, i, v)), '0x' + 'ab'.repeat(32)]);
  const jobs = [
    { anchor: lockNu, role: 'claim', assets: [asset], values: R.netCandidates(10000n) },
    { anchor: lockNu, role: 'refund', assets: [asset], values: R.netCandidates(10000n) },
    { anchor: receipt, role: 'unbond', assets: [asset], values: [4000n] },
    { anchor: receipt, role: 'harvest', index: 0, assets: [asset], values: R.netCandidates(2500000000n) },
    { anchor: receipt, role: 'harvest', index: 1, assets: [asset], values: R.netCandidates(700n) },
    { anchor: posNu, role: 'cdpRelease', index: 0, assets: [asset], values: R.netCandidates(7000n) },
    { anchor: posNu, role: 'cdpRelease', index: 1, assets: [asset], values: [42n] },
  ];
  const { found } = R.walkDirectOutputs({ priv: walletPriv, jobs, isLeaf: (lf) => inTree.has(lf), known: new Set() });
  assert.deepEqual(found.map((n) => [n.role, n.index, n.value]), wants.map(([role, i, , v]) => [role, i, v]));
  for (const n of found) assert.equal(ux.pool.nkToOwner(n.secret).toLowerCase(), n.owner.toLowerCase());
  // a value no candidate covers is not found, and another key finds nothing
  const missing = R.walkDirectOutputs({ priv: walletPriv, jobs: [{ anchor: lockNu, role: 'claim', assets: [asset], values: [9501n, 9499n] }], isLeaf: (lf) => inTree.has(lf), known: new Set() });
  assert.equal(missing.found.length, 0);
  assert.equal(R.walkDirectOutputs({ priv: otherPriv, jobs, isLeaf: (lf) => inTree.has(lf), known: new Set() }).found.length, 0);
});

// ── farm harvest and unbond through the assemblers and recover() ──
function farmLogs(events) {
  return events.map((e, i) => {
    const base = { address: CFG.pool, blockNumber: '0x' + (CFG.deployBlock + 1).toString(16), logIndex: '0x' + i.toString(16), transactionHash: e.txHash || tx(900 + i) };
    if (e.type === 'LeavesInserted') return { ...base, topics: [evLog.TOPIC0.LeavesInserted, '0x' + w(e.firstLeafIndex)], data: encodeAbiParameters([{ type: 'bytes32[]' }, { type: 'bytes[]' }], [e.leaves, e.memos]) };
    if (e.type === 'NullifiersSpent') return { ...base, topics: [evLog.TOPIC0.NullifiersSpent], data: encodeAbiParameters([{ type: 'bytes32[]' }], [e.nullifiers]) };
    if (e.type === 'Bonded') return { ...base, address: FARM.manager, topics: [evLog.TOPIC0.Bonded, e.receipt, '0x' + w(e.pid)], data: '0x' + w(e.shares) + w(e.unlockAt) };
    if (e.type === 'Harvested') return { ...base, address: FARM.manager, topics: [evLog.TOPIC0.Harvested, e.receipt, '0x' + w(e.pid)], data: '0x' + w(e.reward) };
    throw new Error('unsupported test event ' + e.type);
  });
}

test('farmHarvest / farmUnbond: reward and released-share keys derive from the receipt and the harvest ordinal; recover() finds both with no memo', async () => {
  const ux0 = mkUx();
  const pool = ux0.pool;
  const P0 = FARM.pools[0];
  const c32 = '0x' + '00'.repeat(12) + MANAGER.slice(2);
  const tree = new pool.Tree();
  const aNote = ownNote(ux0, walletPriv, '0x' + '0a'.repeat(32), 0, 5000, tree);
  const pos = ux0.lpBondPosition({ walletPriv, controller: FARM.manager, lpAsset: P0.lpAsset, anchorLeaf: aNote.leaf });
  const receipt = pool.farmReceiptLeaf(c32, P0.lpAsset, 4000n, pos.owner, pos.nonce);
  let events = [
    leavesEv(0, [aNote.leaf], [sealTo(ux0, walletPriv, aNote)], tx(20)),
    nullifiersEv([nuOf(ux0, aNote)], tx(21)),
    leavesEv(1, [receipt], null, tx(21)), { type: 'Bonded', receipt, pid: 0, shares: 4000n, unlockAt: 0, txHash: tx(21) },
  ];
  const REWARD = 2500000000n;
  const submitted = [];
  const handler = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + (CFG.deployBlock + 10).toString(16);
    if (method === 'eth_getLogs') return farmLogs(events);
    if (method !== 'eth_call') return undefined;
    const { to, data } = params[0];
    if (String(to).toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return '0x';
    const sel = data.slice(2, 10);
    if (sel === '514ea4bf') return '0x' + [0n, 4000n, 0n, 0n, 1n].map(w).join('');
    if (sel === '1808eeb8') return '0x' + w(REWARD);
    if (sel === '3717b324') return '0x' + w(0n) + w(1n);
    return '0x0';
  };
  const ux = mkUx(handler, { http: async (url, b) => {
    const obj = String(url).includes('/confidential/submit') ? (submitted.push(b), { jobId: 'j', status: 'settled' }) : { jobId: 'j', status: 'settled' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  } });
  const wait = { intervalMs: 0, sleep: async () => {} };
  const [position] = await ux.farmPositions({ walletPriv, events });
  assert.equal(position.receiptLeaf, receipt);

  await ux.farmHarvest({ walletPriv, position, waitOpts: wait });
  const h0 = submitted.at(-1).op;
  const rewardOwner0 = pool.nkToOwner(derive(walletPriv, receipt, 'harvest', 0).nk);
  assert.equal(h0.rewardOwner, rewardOwner0, 'the reward note is owned by the derived key');
  assert.equal(h0.harvestNonce, derive(walletPriv, receipt, 'harvestNonce', 0).nk, 'the freshness nonce derives too, from the same ordinal');
  const rewardLeaf0 = pool.leaf(FARM.rewardAsset, h0.rewardCx, h0.rewardCy, rewardOwner0);

  // once that harvest lands the ordinal moves on: the next harvest of the receipt uses other keys
  events = [...events, { type: 'Harvested', receipt, pid: 0, reward: REWARD, txHash: tx(70) }, leavesEv(2, [rewardLeaf0], null, tx(70))];
  await ux.farmHarvest({ walletPriv, position, waitOpts: wait });
  const h1 = submitted.at(-1).op;
  assert.notEqual(h1.harvestNonce, h0.harvestNonce); assert.notEqual(h1.rewardOwner, h0.rewardOwner);
  assert.equal(h1.rewardOwner, pool.nkToOwner(derive(walletPriv, receipt, 'harvest', 1).nk));

  await ux.farmUnbond({ walletPriv, position, forfeitPending: true, waitOpts: wait });
  const ub = submitted.at(-1).op;
  assert.equal(ub.lpOwner, pool.nkToOwner(derive(walletPriv, receipt, 'unbond', 0).nk));
  const releaseLeaf = pool.leaf(P0.lpAsset, ub.releaseCx, ub.releaseCy, ub.lpOwner);
  events = [...events, leavesEv(3, [releaseLeaf], null, tx(71))];

  const r = await ux.recover({ walletPriv, events, ...noFlags, farm: true, deep: false });
  const byRole = Object.fromEntries(r.notes.map((n) => [`${n.role}${n.roleIndex}`, n]));
  assert.equal(BigInt(byRole.harvest0.value), REWARD); assert.equal(byRole.harvest0.leaf, rewardLeaf0); assert.equal(byRole.harvest0.asset, FARM.rewardAsset);
  assert.equal(BigInt(byRole.unbond0.value), 4000n); assert.equal(byRole.unbond0.leaf, releaseLeaf); assert.equal(byRole.unbond0.asset, P0.lpAsset);
  assert.equal(r.diagnostics.notes.viaDerivedOutputs, 2, 'the second harvest never landed, so only one reward note exists');
  assert.equal(r.diagnostics.notes.emptyMemoLeavesNotAttributed, 1, 'only the receipt leaf itself is left: a position, not a note');
});
