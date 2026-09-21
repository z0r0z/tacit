import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialFarmProgram, formatUnits } from '../dapp/confidential-farm-program.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const deps = { secp, keccak256: keccak_256, sha256: (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest()) };

const { encodeAbiParameters, decodeFunctionData, encodeFunctionData, parseAbi } =
  await import('../worker-relay/node_modules/viem/_esm/index.js');

const FARM = getConfidentialDeployment('mainnet').farm;
const MANAGER = FARM.manager.toLowerCase();
const POOL = getConfidentialDeployment('mainnet').pool.toLowerCase();
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const sel = (sig) => Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex').slice(0, 8);
const AGG = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);

// A tiny stand-in for the manager, the pool and Multicall3, decoded/encoded with viem so the module's hand-rolled
// aggregate3 codec is checked against an independent ABI implementation.
function makeChain(state) {
  const single = (to, data) => {
    const s = data.slice(2, 10), arg = data.slice(10);
    if (to === MULTICALL && s === sel('getCurrentBlockTimestamp()')) return '0x' + w(state.now);
    if (to === POOL && s === sel('farmTreasury(address)')) return '0x' + w(state.treasury);
    if (to === POOL && s === sel('pools(bytes32)')) {
      const p = state.amm[('0x' + arg).toLowerCase()];
      return '0x' + (p ? [1n, p.a, p.b, p.rA, p.rB, 30n, p.shares] : [0n, 0n, 0n, 0n, 0n, 0n, 0n]).map(w).join('');
    }
    if (to !== MANAGER) throw new Error('no such contract ' + to);
    const key = ('0x' + arg.slice(0, 64)).toLowerCase();
    switch (s) {
      case sel('gov()'): return '0x' + w(BigInt(state.gov));
      case sel('pendingGov()'): return '0x' + w(BigInt(state.pendingGov || 0));
      case sel('rate()'): return '0x' + w(state.rate);
      case sel('periodFinish()'): return '0x' + w(state.periodFinish);
      case sel('totalAllocPoint()'): return '0x' + w(state.pools.reduce((t, p) => t + p.alloc, 0n));
      case sel('poolLength()'): return '0x' + w(state.pools.length);
      case sel('outstandingReward()'): return '0x' + w(state.outstanding);
      case sel('poolInfo(uint256)'): {
        const p = state.pools[Number(BigInt('0x' + arg.slice(0, 64)))];
        return '0x' + [BigInt(p.stake), p.shares, 0n, 0n, p.alloc, 0n, p.lock || 0n].map(w).join('');
      }
      case sel('pidOf(bytes32)'): {
        const i = state.pools.findIndex((p) => p.stake.toLowerCase() === key);
        return '0x' + w(i < 0 ? 0 : i) + w(i < 0 ? 0 : 1);
      }
      case sel('positions(bytes32)'): {
        const p = state.positions[key] || { entryRps: 0n, shares: 0n, unlockAt: 0n, pid: 0n, live: false };
        return '0x' + [p.entryRps, p.shares, p.unlockAt, p.pid, p.live ? 1n : 0n].map(w).join('');
      }
      case sel('pending(bytes32)'): return '0x' + w((state.positions[key] || {}).pending || 0n);
      default: throw new Error('unhandled selector ' + s);
    }
  };
  return async (method, params) => {
    if (method !== 'eth_call') throw new Error('unexpected method ' + method);
    state.calls = (state.calls || 0) + 1;
    const { to, data } = params[0];
    if (to.toLowerCase() === MULTICALL && data.startsWith('0x' + sel('aggregate3((address,bool,bytes)[])'))) {
      if (state.noMulticall) throw new Error('execution reverted');
      const { args: [calls] } = decodeFunctionData({ abi: AGG, data });
      const out = calls.map((c) => { try { return { success: true, returnData: single(c.target.toLowerCase(), c.callData) }; } catch { return { success: false, returnData: '0x' }; } });
      return encodeFunctionData({ abi: parseAbi(['function r((bool success, bytes returnData)[] out)']), functionName: 'r', args: [out] }).replace(/^0x[0-9a-f]{8}/, '0x');
    }
    return single(to.toLowerCase(), data);
  };
}

const LP0 = FARM.pools[0].lpAsset, LP1 = FARM.pools[1].lpAsset, LP2 = FARM.pools[2].lpAsset;
const baseState = (over = {}) => ({
  now: 1_800_000_000n, gov: '0x' + 'ab'.repeat(20), pendingGov: 0, rate: 11574n, periodFinish: 1_800_000_000n + 864000n,
  treasury: 50_000_000_000_000n, outstanding: 123456789n, positions: {}, amm: {},
  pools: [{ stake: LP0, shares: 1000n, alloc: 50n }, { stake: LP1, shares: 700n, alloc: 30n }, { stake: LP2, shares: 0n, alloc: 20n }],
  ...over,
});

test('formatUnits: 1e-8 value units at the 1e10 scale, trailing zeros trimmed', () => {
  assert.equal(formatUnits(0n), '0');
  assert.equal(formatUnits(1n), '0.00000001');
  assert.equal(formatUnits(100000000n), '1');
  assert.equal(formatUnits(123456789n), '1.23456789');
  assert.equal(formatUnits(5n * 10n ** 13n), '500000');
  assert.equal(formatUnits(7n, 1n, 6), '0.000007', 'unit scale and decimals are parameters');
});

test('config: mainnet farm block + farmControllers wired to the manager; other networks off', () => {
  const m = getConfidentialDeployment('mainnet');
  assert.equal(m.farm.pools.length, 3);
  assert.equal(m.farm.pools.reduce((s, p) => s + p.allocPoint, 0), 100);
  for (const p of m.farm.pools) assert.equal(m.farmControllers[p.poolId.toLowerCase()], m.farm.manager, 'each pool bonds into the manager');
  assert.deepEqual(Object.keys(m.farmControllers).length, 3);
  const s = getConfidentialDeployment('signet');
  assert.equal(s.farm, null); assert.deepEqual(s.farmControllers, {});
});

test('program(): active epoch, per-pool split, idle pool earns nothing', async () => {
  const st = baseState();
  const fp = makeConfidentialFarmProgram({ rpc: makeChain(st), config: { pool: POOL, ...FARM } });
  const p = await fp.program();
  assert.equal(p.manager, MANAGER);
  assert.equal(p.rewardAsset, FARM.rewardAsset);
  assert.equal(p.gov, '0x' + 'ab'.repeat(20));
  assert.equal(p.pendingGov, '0x' + '00'.repeat(20));
  assert.deepEqual(p.epoch, {
    active: true, rate: '11574', ratePerDayTac: '9.999936', periodFinish: 1_800_864_000, remainingSeconds: 864000,
    treasuryTac: '500000', treasuryUnits: '50000000000000', outstandingTac: '1.23456789', outstandingUnits: '123456789',
  });
  assert.equal(p.pools.length, 3);
  assert.deepEqual(p.pools.map((x) => x.sharePct), ['50.00', '30.00', '20.00']);
  assert.deepEqual(p.pools.map((x) => x.tacPerDayForPool), ['4.999968', '2.9999808', '0']);
  assert.deepEqual(p.pools.map((x) => x.idle), [false, false, true]);
  assert.deepEqual(p.pools.map((x) => x.pair), ['TAC/cETH', 'cETH/cUSD', 'cETH/cBTC']);
  assert.equal(p.pools[0].poolId, FARM.pools[0].poolId);
  assert.equal(p.pools[2].totalShares, '0');
  JSON.stringify(p); // plain JSON: no BigInt survives
  assert.ok(st.calls <= 3, 'a full read is two multicall rounds, not one call per field');
});

test('program(): finished epoch reports zero emission everywhere; a 100%-idle program too', async () => {
  const fin = baseState({ periodFinish: 1_799_000_000n });
  const p = await makeConfidentialFarmProgram({ rpc: makeChain(fin), config: { pool: POOL, ...FARM } }).program();
  assert.equal(p.epoch.active, false);
  assert.equal(p.epoch.remainingSeconds, 0);
  assert.equal(p.epoch.ratePerDayTac, '0');
  assert.equal(p.epoch.rate, '11574', 'the stored rate is reported as-is');
  assert.deepEqual(p.pools.map((x) => x.tacPerDayForPool), ['0', '0', '0']);
  const idle = baseState({ pools: baseState().pools.map((x) => ({ ...x, shares: 0n })) });
  const q = await makeConfidentialFarmProgram({ rpc: makeChain(idle), config: { pool: POOL, ...FARM } }).program();
  assert.ok(q.pools.every((x) => x.idle && x.tacPerDayForPool === '0'));
});

test('program(): falls back to parallel eth_calls when Multicall3 is unavailable; unknown pools keep chain data', async () => {
  const st = baseState({ noMulticall: true, pools: [...baseState().pools, { stake: '0x' + '77'.repeat(32), shares: 5n, alloc: 0n }] });
  const p = await makeConfidentialFarmProgram({ rpc: makeChain(st), config: { pool: POOL, ...FARM } }).program();
  assert.equal(p.pools.length, 4);
  assert.equal(p.pools[3].pair, null, 'a pool the config does not know is still reported');
  assert.equal(p.pools[3].tacPerDayForPool, '0', 'zero allocation earns nothing');
  assert.equal(p.epoch.remainingSeconds, 864000);
});

test('position / pending / pidOf', async () => {
  const leaf = '0x' + '12'.repeat(32);
  const st = baseState({ positions: { [leaf]: { entryRps: 9n, shares: 250n, unlockAt: 1_900_000_000n, pid: 1n, live: true, pending: 250000000n } } });
  const fp = makeConfidentialFarmProgram({ rpc: makeChain(st), config: { pool: POOL, ...FARM } });
  assert.deepEqual(await fp.pending(leaf), { units: '250000000', tac: '2.5' });
  const pos = await fp.position(leaf);
  assert.equal(pos.live, true); assert.equal(pos.shares, '250'); assert.equal(pos.pid, 1); assert.equal(pos.unlockAt, 1_900_000_000);
  assert.equal(pos.pendingTac, '2.5');
  const none = await fp.position('0x' + '34'.repeat(32));
  assert.equal(none.live, false); assert.equal(none.pendingUnits, '0');
  assert.equal(await fp.pidOf(LP1), 1);
  assert.equal(await fp.pidOf('0x' + '99'.repeat(32)), null);
  await assert.rejects(fp.pending('0x1234'), /32-byte/);
});

test('aprInputs(): yearly emission per pool + the AMM state to value a share', async () => {
  const st = baseState({ amm: { [FARM.pools[0].poolId.toLowerCase()]: { a: 1n, b: 2n, rA: 4000n, rB: 9000n, shares: 2000n } } });
  const a = await makeConfidentialFarmProgram({ rpc: makeChain(st), config: { pool: POOL, ...FARM } }).aprInputs();
  assert.equal(a.pools[0].tacPerYearUnits, (11574n * 31536000n * 50n / 100n).toString());
  assert.equal(a.pools[0].stakedShares, '1000');
  assert.equal(a.pools[0].amm.reserveA, '4000'); assert.equal(a.pools[0].amm.totalShares, '2000');
  assert.equal(a.pools[0].amm.stakedPct, '50.00');
  assert.equal(a.pools[1].amm, null, 'an uninitialized AMM pool reads as null');
  assert.equal(a.pools[2].tacPerYearUnits, '0', 'idle pool');
});

// ── wallet-side: position keys, discovery, harvest / unbond witnesses ──
const walletPriv = '0x' + 'c4'.repeat(32);
function scene({ liveReceipt = true, unlockAt = 0n } = {}) {
  const ux = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: async () => { throw new Error('no network'); } });
  const pool = ux.pool, id = ux.identity(walletPriv);
  const mkNote = (asset, idx, value) => {
    const dn = pool.deriveNote(id.priv, asset, idx);
    const blinding = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
    const owner = pool.nkToOwner(dn.secret);
    return { asset, value: String(value), ...pool.commitXY(BigInt(value), blinding), owner, secret: dn.secret, blinding };
  };
  const bonded = mkNote(LP0, 0, 4000), loose = mkNote(LP0, 1, 900), other = mkNote(LP1, 2, 1500);
  const pos = ux.lpBondPosition({ walletPriv, controller: FARM.manager, lpAsset: LP0, anchorLeaf: pool.leaf(LP0, bonded.cx, bonded.cy, bonded.owner) });
  const c32 = '0x' + '00'.repeat(12) + MANAGER.slice(2);
  const receiptLeaf = pool.farmReceiptLeaf(c32, LP0, 4000n, pos.owner, pos.nonce);
  const seal = (n, leaf) => ux.memo.encodeMemo(ux.memo.sealMemo(id.pubHex, n, () => 7n + BigInt(leaf.length)));
  const leaves = [bonded, loose, other].map((n) => pool.leaf(n.asset, n.cx, n.cy, n.owner));
  const events = [
    { type: 'LeavesInserted', firstLeafIndex: 0, leaves, memos: [bonded, loose, other].map((n, i) => seal(n, leaves[i] + 'x'.repeat(i))) },
    { type: 'LeavesInserted', firstLeafIndex: 3, leaves: [receiptLeaf], memos: ['0x'] },
  ];
  const state = baseState({ positions: { [receiptLeaf]: { entryRps: 1n, shares: 4000n, unlockAt, pid: 0n, live: liveReceipt, pending: 1_000_000_000n } } });
  return { ux, pool, id, bonded, loose, other, pos, receiptLeaf, events, state, c32 };
}

test('farmProgram(): reads through the ux rpc with the configured pool + manager', async () => {
  const chain = makeChain(scene().state);
  const ux2 = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: async (_u, o) => {
    const b = JSON.parse(o.body);
    const obj = { result: await chain(b.method, b.params) };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  } });
  const p = await ux2.farmProgram().program();
  assert.equal(p.manager, MANAGER);
  assert.equal(p.epoch.treasuryTac, '500000', 'the pool treasury is read for the manager');
});

test('position keys: deterministic per (wallet, manager, lpAsset, anchor note); distinct per note and per wallet', () => {
  const { ux, pool, bonded, loose, pos } = scene();
  const again = ux.lpBondPosition({ walletPriv, controller: FARM.manager.toLowerCase(), lpAsset: LP0, anchorLeaf: pool.leaf(LP0, bonded.cx, bonded.cy, bonded.owner) });
  assert.deepEqual(again, pos, 'case-insensitive controller, same key');
  const b = ux.lpBondPosition({ walletPriv, controller: FARM.manager, lpAsset: LP0, anchorLeaf: pool.leaf(LP0, loose.cx, loose.cy, loose.owner) });
  assert.notEqual(b.owner, pos.owner); assert.notEqual(b.nonce, pos.nonce);
  const otherWallet = ux.lpBondPosition({ walletPriv: '0x' + 'd5'.repeat(32), controller: FARM.manager, lpAsset: LP0, anchorLeaf: pool.leaf(LP0, bonded.cx, bonded.cy, bonded.owner) });
  assert.notEqual(otherWallet.owner, pos.owner);
});

test('farmPositions(): finds the live bonded position from chain + key; skips loose notes, other assets and dead receipts', async () => {
  const s = scene();
  const rpcFor = (state) => { const chain = makeChain(state); return async (_u, o) => { const b = JSON.parse(o.body); const obj = { result: await chain(b.method, b.params) }; return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) }; }; };
  const mk = (state) => makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: rpcFor(state) });
  const found = await mk(s.state).farmPositions({ walletPriv, events: s.events });
  assert.equal(found.length, 1);
  const f = found[0];
  assert.equal(f.pid, 0); assert.equal(f.pair, 'TAC/cETH'); assert.equal(f.shares, '4000');
  assert.equal(f.receiptLeaf, s.receiptLeaf); assert.equal(f.receiptIndex, 3);
  assert.equal(f.pendingUnits, '1000000000'); assert.equal(f.pendingTac, '10');
  assert.equal(f.lpAsset, LP0); assert.equal(f.controller, FARM.manager);
  const blob = JSON.stringify(f).toLowerCase();
  assert.ok(!blob.includes(s.pos.ownerPriv.slice(2)), 'the receipt key is never returned');
  assert.ok(!blob.includes(s.pos.nonce.slice(2)), 'nor its nonce');
  // a receipt the manager no longer holds (already unbonded) is dropped
  const dead = scene({ liveReceipt: false });
  assert.deepEqual(await mk(dead.state).farmPositions({ walletPriv, events: dead.events }), []);
  // another wallet sees nothing
  assert.deepEqual(await mk(s.state).farmPositions({ walletPriv: '0x' + 'd5'.repeat(32), events: s.events }), []);
});

// The full RPC surface a wallet needs: eth_call (program), eth_blockNumber + eth_getLogs (event scan), and the relay.
function walletMock(s, submitted) {
  const chain = makeChain(s.state);
  const topic = '0x' + Buffer.from(keccak_256(new TextEncoder().encode('LeavesInserted(uint256,bytes32[],bytes[])'))).toString('hex');
  const enc = (leaves, memos) => encodeAbiParameters([{ type: 'bytes32[]' }, { type: 'bytes[]' }], [leaves, memos]);
  const logs = s.events.map((e) => ({ address: POOL, topics: [topic, '0x' + w(e.firstLeafIndex)], data: enc(e.leaves, e.memos), blockNumber: '0x1', logIndex: '0x0', transactionHash: '0x' + '01'.repeat(32) }));
  return async (url, o) => {
    const b = o && o.body ? JSON.parse(o.body) : null;
    let obj;
    if (String(url).includes('/confidential/submit')) { submitted.push(b); obj = { jobId: 'j', status: 'settled' }; }
    else if (String(url).includes('/confidential/status')) obj = { jobId: 'j', status: 'settled' };
    else if (b.method === 'eth_blockNumber') obj = { result: '0x' + (getConfidentialDeployment('mainnet').deployBlock + 1).toString(16) };
    else if (b.method === 'eth_getLogs') obj = { result: logs };
    else obj = { result: await chain(b.method, b.params) };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
}
const waitOpts = { intervalMs: 0, sleep: async () => {} };
const dump = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)).toLowerCase();

test('farmHarvest(): claims the full pending amount under the re-derived receipt key; ships one sealed reward note', async () => {
  const s = scene(); const submitted = [];
  const ux = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: walletMock(s, submitted) });
  const [position] = await ux.farmPositions({ walletPriv, events: s.events });
  const r = await ux.farmHarvest({ walletPriv, position, waitOpts });
  const sub = submitted.at(-1);
  assert.equal(sub.type, 'farmharvest');
  const pending = 1_000_000_000n;
  assert.equal(BigInt(sub.op.reward), pending);
  assert.equal(r.net, BigInt(sub.op.reward)); assert.equal(r.fee, 0n);
  assert.equal(sub.op.owner, s.pos.owner); assert.equal(sub.op.nonce, s.pos.nonce);
  assert.equal(BigInt(sub.op.shares), 4000n); assert.equal(sub.op.oldIndex, 3);
  assert.equal(sub.op.rewardAsset, FARM.rewardAsset);
  assert.equal(s.pool.merkleRootFrom(s.receiptLeaf, sub.op.oldIndex, sub.op.oldPath).toLowerCase(), sub.op.spendRoot.toLowerCase(), 'membership path reaches the spend root');
  assert.equal(sub.memos.length, 1, 'the reward note carries a recovery memo');
  assert.ok(!dump(r).includes(s.pos.ownerPriv.slice(2)), 'no secret in the result');
  // a fee is carved from the yield and the reward note opens to the net
  await ux.farmHarvest({ walletPriv, position, fee: 500n, waitOpts });
  assert.equal(submitted.at(-1).op.fee, 500);
  await assert.rejects(ux.farmHarvest({ walletPriv, position, fee: 10n ** 12n, waitOpts }), /nothing to claim/);
  // a position that is not this wallet's is refused before any proof work
  await assert.rejects(ux.farmHarvest({ walletPriv: '0x' + 'd5'.repeat(32), position, waitOpts }), /does not belong to this wallet/);
});

test('farmUnbond(): releases the full shares to a fresh owned note; refuses while locked', async () => {
  const s = scene(); const submitted = [];
  const ux = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: walletMock(s, submitted) });
  const [position] = await ux.farmPositions({ walletPriv, events: s.events });
  // reward that has not been harvested is not paid out on unbond, so it is refused unless acknowledged
  await assert.rejects(ux.farmUnbond({ walletPriv, position, waitOpts }), /still pending and would be forfeited/);
  const r = await ux.farmUnbond({ walletPriv, position, forfeitPending: true, waitOpts });
  const sub = submitted.at(-1);
  assert.equal(sub.type, 'farmunbond');
  assert.equal(BigInt(sub.op.shares), 4000n); assert.equal(sub.op.fee, 0);
  assert.equal(sub.op.owner, s.pos.owner); assert.equal(sub.op.lpAsset, LP0);
  assert.equal(sub.memos.length, 1);
  assert.equal(r.shares, 4000n);
  const locked = scene({ unlockAt: 4_000_000_000n });
  const ux2 = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: walletMock(locked, submitted) });
  const [lp] = await ux2.farmPositions({ walletPriv, events: locked.events });
  await assert.rejects(ux2.farmUnbond({ walletPriv, position: lp, forfeitPending: true, waitOpts }), /locked until/);
});

test('farmBond(): derives the deterministic position key from the LP note; refuses an asset the manager has no pool for', async () => {
  const s = scene(); const submitted = [];
  const ux = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: walletMock(s, submitted) });
  const tree = new s.pool.Tree();
  const mkLeg = (n) => { n.leafIndex = tree.insert(s.pool.leaf(n.asset, n.cx, n.cy, n.owner)); return n; };
  const note = mkLeg({ ...s.loose }), note2 = mkLeg({ ...s.other });
  for (const n of [note, note2]) { n.path = tree.rootAndPath(n.leafIndex).path; n.root = tree.root(); }
  const r = await ux.farmBond({ walletPriv, lpNote: note, waitOpts });
  const sub = submitted.at(-1);
  assert.equal(sub.type, 'farmbond');
  const expect = ux.lpBondPosition({ walletPriv, controller: FARM.manager, lpAsset: LP0, anchorLeaf: s.pool.leaf(LP0, note.cx, note.cy, note.owner) });
  assert.equal(sub.op.owner, expect.owner); assert.equal(sub.op.nonce, expect.nonce);
  assert.equal(r.receiptLeaf, s.pool.farmReceiptLeaf(s.c32, LP0, 900n, expect.owner, expect.nonce));
  assert.equal(sub.memos.length, 1, 'one memo for the one receipt leaf');
  assert.equal(r.pid, 0);
  await ux.farmBond({ walletPriv, lpNote: note, waitOpts });
  assert.equal(submitted.at(-1).op.nonce, expect.nonce, 'a retry re-derives the identical position');
  assert.ok(!dump(r).includes(expect.ownerPriv.slice(2)), 'no secret in the result');
  await assert.rejects(ux.farmBond({ walletPriv, lpNote: { ...note, asset: '0x' + '99'.repeat(32) }, waitOpts }), /no pool for this LP asset/);
  await assert.rejects(ux.farmBond({ walletPriv, lpNote: note, controller: '0x' + 'fa'.repeat(20), waitOpts }), /not the configured farm manager/);
  await assert.rejects(ux.farmBond({ walletPriv, waitOpts }), /LP-share note is required/);
});

test('farmRedeem(): unwraps the wTAC note and returns the withdraw + wrap steps as data', async () => {
  const s = scene(); const submitted = [];
  const ux = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: walletMock(s, submitted) });
  const tree = new s.pool.Tree();
  const dn = s.pool.deriveNote(s.id.priv, FARM.rewardAsset, 5);
  const blinding = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
  const owner = s.pool.nkToOwner(dn.secret);
  const note = { asset: FARM.rewardAsset, value: '250000000', ...s.pool.commitXY(250000000n, blinding), owner, secret: dn.secret, blinding };
  note.leafIndex = tree.insert(s.pool.leaf(note.asset, note.cx, note.cy, owner)); note.path = tree.rootAndPath(note.leafIndex).path; note.root = tree.root();
  const to = '0x' + '5a'.repeat(20);
  const r = await ux.farmRedeem({ walletPriv, note, to, feeOpts: { minFee: 10n }, waitOpts });
  const sub = submitted.at(-1);
  assert.equal(sub.type, 'unwrap'); assert.equal(sub.op.recipient.toLowerCase(), to);
  assert.equal(r.recipient.toLowerCase(), to);
  const wei = BigInt(r.unwrap.net) * 10n ** 10n;
  assert.equal(r.next[0].step, 'withdraw'); assert.equal(r.next[0].to, FARM.rewardToken);
  assert.equal(r.next[0].data, '0x' + sel('withdraw(uint256,address)') + w(wei) + '0'.repeat(24) + '5a'.repeat(20));
  assert.equal(r.next[0].amountWei, wei.toString());
  assert.equal(r.next[1].step, 'wrap'); assert.equal(r.next[1].token, FARM.tac);
  await assert.rejects(ux.farmRedeem({ walletPriv, note: { ...note, asset: LP0 } }), /wTAC/);
});
