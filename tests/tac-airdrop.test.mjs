// The TAC airdrop client (dapp/tac-airdrop.js): real allocations recomputed against the real airdrop root, the
// contract's state read through a mocked eth_call, calldata against `cast calldata` vectors, the send paths and the
// shielded-claim plan. Nothing here touches the network.
// Run: node --test tests/tac-airdrop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { leafHash, verifyProof, buildTree, proofFor, formatTac as toolFormatTac } from '../tools/airdrop-tree.mjs';
import {
  makeTacAirdrop, makeRpcCall, formatTac, AirdropError, AIRDROP_DEPLOYMENTS, MULTICALL3, PROOF_HOSTS, PUBLIC_PROOF_HOSTS,
} from '../dapp/tac-airdrop.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

// secp.sign (RFC 6979) needs the sync HMAC set; the dapp's vendor bundle does this.
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const FX = JSON.parse(readFileSync(new URL('./fixtures/tac-airdrop.json', import.meta.url), 'utf8'));
const [BIG, MID, DUST] = FX.entries;   // idx 978 (the largest allocation), idx 52 (14 proof words, shard 00), idx 8141 (one pool unit)
const D = AIRDROP_DEPLOYMENTS[1];
const AIR = D.address, TOKEN = D.token, POOL = D.pool;
const lc = (s) => String(s).toLowerCase();
const flip = (hex) => hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');

// ── ABI helpers written independently of the module ──
const sel = (sig) => Buffer.from(keccak_256(Buffer.from(sig))).toString('hex').slice(0, 8);
const S = {
  claim: sel('claim(uint256,address,uint256,bytes32[])'), claimTo: sel('claimTo(uint256,uint256,bytes32[],address)'),
  claimAndShield: sel('claimAndShield(uint256,uint256,bytes32[],bytes32)'), isClaimed: sel('isClaimed(uint256)'),
  verify: sel('verify(uint256,address,uint256,bytes32[])'), paused: sel('paused()'), balanceOf: sel('balanceOf(address)'),
  depositStatus: sel('depositStatus(bytes32)'), aggregate3: sel('aggregate3((address,bool,bytes)[])'), ts: sel('getCurrentBlockTimestamp()'),
};
const ERR = Object.fromEntries(['Paused', 'ClaimWindowClosed', 'AlreadyClaimed', 'BadProof', 'BadRecipient', 'AmountNotAligned', 'ZeroCommit'].map((n) => [n, sel(`${n}()`)]));
const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
const padR = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
const bool = (b) => '0x' + w32(b ? 1 : 0);
const argWord = (data, i) => data.replace(/^0x/, '').slice(8 + 64 * i, 8 + 64 * (i + 1));
const argNum = (data, i) => BigInt('0x' + argWord(data, i));
const argAddr = (data, i) => '0x' + argWord(data, i).slice(24);
const argProof = (data, lenWord) => Array.from({ length: Number(argNum(data, lenWord)) }, (_, k) => '0x' + argWord(data, lenWord + 1 + k));

function decodeAggregate3Input(data) {
  const h = data.replace(/^0x/, '').slice(8);
  const W = (i) => Number(BigInt('0x' + h.slice(64 * i, 64 * (i + 1))));
  const arr = W(0) / 32, n = W(arr), calls = [];
  for (let i = 0; i < n; i++) {
    const e = arr + 1 + W(arr + 1 + i) / 32;
    const bo = e + W(e + 2) / 32, len = W(bo);
    calls.push({ target: '0x' + h.slice(64 * e + 24, 64 * (e + 1)), allowFailure: W(e + 1) !== 0, data: '0x' + h.slice(64 * (bo + 1), 64 * (bo + 1) + len * 2) });
  }
  return calls;
}
function encodeAggregate3Output(datas) {
  const hexs = datas.map((d) => d.replace(/^0x/, ''));
  const elems = hexs.map((h) => w32(1) + w32(0x40) + w32(h.length / 2) + padR(h));
  let off = datas.length * 32;
  const offs = elems.map((e) => { const o = w32(off); off += e.length / 2; return o; });
  return '0x' + w32(0x20) + w32(datas.length) + offs.join('') + elems.join('');
}

// ── a small fake chain: the distributor, the token, the pool's deposit registry and Multicall3 ──
function makeChain(o = {}) {
  const st = {
    air: AIR, token: TOKEN, pool: POOL, root: FX.root, deadline: D.deadline, timestamp: 1790030000, paused: false,
    claimed: new Set(), balance: 10n ** 24n, unitScale: 10n ** 10n, deposits: new Map(), multicall: true,
    forceRevert: null, failWith: null, calls: [], ...o,
  };
  const revert = (hex) => { throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' + hex }); };
  const proofOk = (index, account, amount, proof) => verifyProof(proof, st.root, leafHash(index, account, amount));
  function consume(index, account, amount, proof) {
    if (st.forceRevert) revert(st.forceRevert);
    if (st.paused) revert(ERR.Paused);
    if (st.timestamp > st.deadline) revert(ERR.ClaimWindowClosed);
    if (st.claimed.has(index)) revert(ERR.AlreadyClaimed);
    if (!proofOk(index, account, amount, proof)) revert(ERR.BadProof);
  }
  function distributor({ data, from }) {
    const s = data.slice(2, 10);
    const sender = from || '0x' + '00'.repeat(20);
    switch (s) {
      case S.isClaimed: return bool(st.claimed.has(Number(argNum(data, 0))));
      case S.paused: return bool(st.paused);
      case S.verify: return bool(proofOk(Number(argNum(data, 0)), argAddr(data, 1), argNum(data, 2), argProof(data, 4)));
      case S.claim: consume(Number(argNum(data, 0)), argAddr(data, 1), argNum(data, 2), argProof(data, 4)); return '0x';
      case S.claimTo: {
        consume(Number(argNum(data, 0)), sender, argNum(data, 1), argProof(data, 4));
        if (/^0x0{40}$/.test(argAddr(data, 3)) || [st.air, st.token, st.pool].some((a) => lc(a) === argAddr(data, 3))) revert(ERR.BadRecipient);
        return '0x';
      }
      case S.claimAndShield:
        if (/^0{64}$/.test(argWord(data, 3))) revert(ERR.ZeroCommit);
        if (argNum(data, 1) % st.unitScale !== 0n) revert(ERR.AmountNotAligned);
        consume(Number(argNum(data, 0)), sender, argNum(data, 1), argProof(data, 4));
        return '0x';
      default: throw new Error(`unexpected distributor selector ${s}`);
    }
  }
  function route(to, data, from) {
    if (to === lc(st.air)) return distributor({ data, from });
    if (to === lc(st.token) && data.slice(2, 10) === S.balanceOf) return '0x' + w32(st.balance);
    if (to === lc(st.pool) && data.slice(2, 10) === S.depositStatus) return '0x' + w32(st.deposits.get('0x' + argWord(data, 0)) || 0);
    return '0x';   // an address with no contract answers an eth_call with empty data
  }
  async function call({ to, data, from }) {
    st.calls.push({ to: lc(to), data, from });
    if (st.failWith) throw st.failWith;
    if (lc(to) === lc(MULTICALL3)) {
      if (!st.multicall) return '0x';
      assert.equal(data.slice(2, 10), S.aggregate3);
      return encodeAggregate3Output(decodeAggregate3Input(data).map((c) => {
        assert.equal(c.allowFailure, false);
        return c.target === lc(MULTICALL3) && c.data.slice(2, 10) === S.ts ? '0x' + w32(st.timestamp) : route(c.target, c.data);
      }));
    }
    return route(lc(to), data, from);
  }
  return { st, call };
}

// ── a fake host for the proof files ──
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const http = (status) => ({ ok: false, status, json: async () => { throw new Error('no body'); } });
const shardOf = (...es) => ({ root: FX.root, claims: Object.fromEntries(es.map((e) => [e.address, { index: e.index, amount: e.amount, proof: e.proof }])) });
const SHARDS = { '1c': shardOf(BIG), '00': shardOf(MID), f0: shardOf(DUST) };
const serve = (shards) => (xx) => {
  if (xx === 'manifest') return ok({ root: FX.root, count: 0, shards: Object.keys(shards).sort() });
  return shards[xx] ? ok(shards[xx]) : http(404);
};
function makeFetch(hosts, log = []) {
  return async (url) => {
    log.push(url);
    const m = /^(.*)\/([0-9a-f]{2}|manifest)\.json$/.exec(url);
    const h = m && hosts[m[1]];
    return h ? h(m[2]) : http(404);
  };
}

function setup({ chain, hosts, ...opts } = {}) {
  const c = makeChain(chain);
  const fetchLog = [];
  const air = makeTacAirdrop({
    call: c.call, keccak256: keccak_256, fetchImpl: makeFetch(hosts || { '/x': serve(SHARDS) }, fetchLog),
    proofsBase: '/x', sleep: async () => {}, ...opts,
  });
  return { air, chain: c, st: c.st, fetchLog };
}
const sender = () => { const sent = []; return { sent, send: async (tx) => { sent.push(tx); return '0x' + 'cd'.repeat(32); } }; };
const refused = async (p, code) => assert.rejects(p, (e) => e instanceof AirdropError && e.code === code, `expected ${code}`);

// ── formatting ──
test('formatTac: exact decimal strings, and the same as the tree tool', () => {
  assert.equal(formatTac(0), '0');
  assert.equal(formatTac(10n ** 10n), '0.00000001');
  assert.equal(formatTac('216176408192580000000000'), '216176.40819258');
  assert.equal(formatTac(10n ** 18n), '1');
  assert.equal(formatTac(1), '0.000000000000000001');
  assert.equal(formatTac(123456789, 6), '123.456789');
  assert.equal(formatTac(5, 0), '5');
  for (const v of [0n, 1n, 10n ** 10n, 999999n * 10n ** 18n + 1n, 2n ** 255n]) assert.equal(formatTac(v), toolFormatTac(v));
  assert.throws(() => formatTac(-1), RangeError);
});

// ── the proof against the real root ──
test('the real entries recompute to the real root, and the module accepts each of them', async () => {
  for (const e of FX.entries) {
    assert.ok(verifyProof(e.proof, FX.root, leafHash(e.index, e.address, BigInt(e.amount))), 'tool agrees');
    const { air } = setup();
    const s = await air.status(e.address);
    assert.equal(s.eligible, true, e.address);
    assert.equal(s.index, e.index);
    assert.equal(s.amountWei, e.amount);
    assert.deepEqual(s.proof, e.proof);
  }
});

test('status: an eligible allocation, in full', async () => {
  const { air } = setup();
  const s = await air.status(BIG.address);
  assert.equal(s.address, BIG.address);
  assert.equal(s.contract, AIR);
  assert.equal(s.eligible, true);
  assert.equal(s.claimable, true);
  assert.equal(s.reason, null);
  assert.equal(s.index, 978);
  assert.equal(s.amountWei, '216176408192580000000000');
  assert.equal(s.amountTac, '216176.40819258');
  assert.deepEqual([s.claimed, s.paused, s.open, s.funded, s.canShield], [false, false, true, true, true]);
  assert.equal(s.deadline, 1797803449);
  assert.equal(s.claimByISO, '2026-12-20T21:50:49Z');
  assert.equal(s.secondsLeft, 1797803449 - 1790030000);
  assert.equal(s.root, FX.root);
  assert.equal(s.error, undefined);
});

test('status: mixed-case, upper-case and padded addresses resolve to the same entry', async () => {
  const { air } = setup();
  for (const a of ['0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20', '0x1C0AA8CCD568D90D61659F060D1BFB1E6F855A20', `  ${BIG.address}\n`]) {
    const s = await air.status(a);
    assert.equal(s.eligible, true, a);
    assert.equal(s.address, BIG.address);
  }
});

test('status: bad addresses come back as an error, not a throw', async () => {
  const { air, chain, fetchLog } = setup();
  for (const a of ['', null, undefined, 'nope', '0x1234', '0x' + 'zz'.repeat(20), '0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855a20']) {
    const s = await air.status(a);
    assert.equal(s.reason, 'error', String(a));
    assert.equal(s.error.code, 'bad-address');
    assert.equal(s.eligible, false);
    assert.equal(s.address, null);
  }
  assert.deepEqual([chain.st.calls.length, fetchLog.length], [0, 0], 'nothing is read for a bad address');
});

// ── the chain read ──
test('status reads the contract state in one eth_call, with the calldata cast produces', async () => {
  const { air, chain } = setup();
  await air.status(BIG.address);
  assert.equal(chain.st.calls.length, 1);
  assert.equal(chain.st.calls[0].to, lc(MULTICALL3));
  assert.equal(chain.st.calls[0].data, FX.vectors.aggregate3State0);
  const inner = decodeAggregate3Input(chain.st.calls[0].data);
  assert.deepEqual(inner.map((c) => c.data.slice(2, 10)), [S.isClaimed, S.paused, S.balanceOf, S.verify, S.ts]);
  assert.equal(inner[3].data, FX.vectors.verify0);
});

test('status without Multicall3 reads each value with its own call and the local clock', async () => {
  const { air, chain } = setup({ chain: { multicall: false }, now: () => 1790030001 });
  const s = await air.status(BIG.address);
  assert.equal(s.claimable, true);
  assert.equal(s.secondsLeft, 1797803449 - 1790030001);
  const targets = chain.st.calls.map((c) => c.data.slice(2, 10));
  assert.deepEqual(targets.slice(1).sort(), [S.isClaimed, S.paused, S.balanceOf, S.verify].sort());
  assert.equal(chain.st.calls[0].to, lc(MULTICALL3), 'the batch was tried first');
});

test('multicall: false skips the batch', async () => {
  const { air, chain } = setup({ multicall: false });
  assert.equal((await air.status(BIG.address)).eligible, true);
  assert.equal(chain.st.calls.length, 4);
  assert.ok(chain.st.calls.every((c) => c.to !== lc(MULTICALL3)));
});

test('status: not in the airdrop, whether the shard exists or not', async () => {
  const { air, chain } = setup();
  for (const a of ['0x1c' + '11'.repeat(19), '0x77' + '22'.repeat(19)]) {
    const s = await air.status(a);
    assert.equal(s.eligible, false, a);
    assert.equal(s.claimable, false);
    assert.equal(s.reason, 'not-listed');
    assert.equal(s.error, undefined);
    assert.match(s.message, /not in the airdrop/);
    assert.equal(s.deadline, 1797803449);
  }
  assert.equal(chain.st.calls.length, 0, 'the chain is not read for an unlisted address');
});

test('status: already claimed, paused, closed and unfunded', async () => {
  let r = setup({ chain: { claimed: new Set([978]) } });
  let s = await r.air.status(BIG.address);
  assert.deepEqual([s.eligible, s.claimed, s.claimable, s.reason], [true, true, false, 'claimed']);

  r = setup({ chain: { paused: true } });
  s = await r.air.status(BIG.address);
  assert.deepEqual([s.paused, s.claimable, s.reason], [true, false, 'paused']);

  r = setup({ chain: { timestamp: D.deadline + 1 } });
  s = await r.air.status(BIG.address);
  assert.deepEqual([s.open, s.claimable, s.reason, s.secondsLeft], [false, false, 'closed', 0]);

  r = setup({ chain: { timestamp: D.deadline } });
  s = await r.air.status(BIG.address);
  assert.deepEqual([s.open, s.claimable, s.secondsLeft], [true, true, 0], 'the deadline second itself still claims');

  r = setup({ chain: { balance: BigInt(BIG.amount) - 1n } });
  s = await r.air.status(BIG.address);
  assert.deepEqual([s.funded, s.claimable, s.reason], [false, false, 'unfunded']);

  r = setup({ chain: { balance: BigInt(BIG.amount) } });
  assert.equal((await r.air.status(BIG.address)).funded, true, 'exactly enough is enough');
});

test('status: when several apply, claimed comes first, then paused, closed, unfunded', async () => {
  const all = { claimed: new Set([978]), paused: true, timestamp: D.deadline + 5, balance: 0n };
  assert.equal((await setup({ chain: all }).air.status(BIG.address)).reason, 'claimed');
  assert.equal((await setup({ chain: { ...all, claimed: new Set() } }).air.status(BIG.address)).reason, 'paused');
  assert.equal((await setup({ chain: { ...all, claimed: new Set(), paused: false } }).air.status(BIG.address)).reason, 'closed');
  assert.equal((await setup({ chain: { ...all, claimed: new Set(), paused: false, timestamp: 1790030000 } }).air.status(BIG.address)).reason, 'unfunded');
});

test('status: the smallest allocation is one pool unit and can be shielded', async () => {
  const s = await setup().air.status(DUST.address);
  assert.deepEqual([s.amountWei, s.amountTac, s.canShield], ['10000000000', '0.00000001', true]);
});

// ── a contract of your own, and an amount the pool cannot take ──
function syntheticTree() {
  const rows = [
    { address: '0x' + '11'.repeat(20), amount: 5n * 10n ** 18n },
    { address: '0x' + '22'.repeat(20), amount: 10n ** 10n + 1n },   // sub-unit dust
    { address: '0x' + '33'.repeat(20), amount: 7n * 10n ** 18n },
    { address: '0x' + '44'.repeat(20), amount: 10n ** 10n },
  ];
  const tree = buildTree(rows.map((r, i) => leafHash(i, r.address, r.amount)));
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  return {
    root: hex(tree[0]),
    entry: (i) => ({ address: rows[i].address, index: i, amount: rows[i].amount.toString(), proof: proofFor(tree, i).map(hex) }),
    shards: (i) => ({ [rows[i].address.slice(2, 4)]: { root: hex(tree[0]), claims: { [rows[i].address]: { index: i, amount: rows[i].amount.toString(), proof: proofFor(tree, i).map(hex) } } } }),
  };
}
const CUSTOM = '0x' + '33'.repeat(19) + '99';
function customSetup(i, chain = {}) {
  const t = syntheticTree();
  const c = makeChain({ air: CUSTOM, root: t.root, deadline: 2000000000, timestamp: 1900000000, ...chain });
  const air = makeTacAirdrop({
    call: c.call, keccak256: keccak_256, fetchImpl: makeFetch({ '/x': serve(t.shards(i)) }), proofsBase: '/x', sleep: async () => {},
    contract: CUSTOM, root: t.root, deadline: 2000000000, token: TOKEN, unitScale: '10000000000', pool: POOL, assetId: D.assetId,
  });
  return { air, chain: c, t, entry: t.entry(i) };
}

test('status: an allocation with sub-unit dust cannot be shielded, and can still be claimed', async () => {
  const { air, entry } = customSetup(1);
  const s = await air.status(entry.address);
  assert.deepEqual([s.eligible, s.canShield, s.claimable, s.amountWei], [true, false, true, '10000000001']);
  assert.equal(s.amountTac, '0.000000010000000001');
  assert.equal(air.config.address, CUSTOM);
  await air.buildClaim(entry.address);
  await refused(air.buildClaimAndShield(entry.address, FX.commit), 'not-aligned');
});

test('every leaf of trees of every small size verifies, including the one-leaf tree with an empty proof', async () => {
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  for (let n = 1; n <= 17; n++) {
    const rows = Array.from({ length: n }, (_, i) => ({ address: '0x' + (i + 1).toString(16).padStart(2, '0') + 'ab'.repeat(19), amount: BigInt(i + 1) * 10n ** 10n }));
    const tree = buildTree(rows.map((r, i) => leafHash(i, r.address, r.amount)));
    const root = hex(tree[0]);
    const shards = {};
    rows.forEach((r, i) => {
      const xx = r.address.slice(2, 4);
      shards[xx] = shards[xx] || { root, claims: {} };
      shards[xx].claims[r.address] = { index: i, amount: r.amount.toString(), proof: proofFor(tree, i).map(hex) };
    });
    const c = makeChain({ air: CUSTOM, root, deadline: 2000000000, timestamp: 1900000000 });
    const air = makeTacAirdrop({
      call: c.call, keccak256: keccak_256, fetchImpl: makeFetch({ '/x': serve(shards) }), proofsBase: '/x',
      contract: CUSTOM, root, deadline: 2000000000, token: TOKEN, unitScale: '10000000000',
    });
    for (const [i, r] of rows.entries()) {
      const s = await air.status(r.address);
      assert.equal(s.claimable, true, `n=${n} leaf ${i}: ${s.message}`);
      assert.equal(s.amountWei, r.amount.toString());
    }
    if (n === 1) assert.deepEqual((await air.entryFor(rows[0].address)).proof, []);
  }
});

test('a custom contract must bring its own root, deadline, token and unit scale', () => {
  const base = { call: async () => '0x', keccak256: keccak_256, contract: CUSTOM };
  assert.throws(() => makeTacAirdrop({ ...base }), /custom contract needs/);
  assert.throws(() => makeTacAirdrop({ ...base, root: FX.root, deadline: 1, token: TOKEN }), /custom contract needs/);
  assert.ok(makeTacAirdrop({ ...base, root: FX.root, deadline: 1, token: TOKEN, unitScale: '1' }));
  assert.throws(() => makeTacAirdrop({ keccak256: keccak_256 }), /call is required/);
  assert.throws(() => makeTacAirdrop({ call: async () => '0x' }), /keccak256 is required/);
});

// ── untrusted input ──
test('a tampered proof word, amount or index is rejected locally and never reaches the chain', async () => {
  const bad = [
    { ...BIG, proof: [flip(BIG.proof[0]), ...BIG.proof.slice(1)] },
    { ...BIG, proof: BIG.proof.slice(0, -1) },
    { ...BIG, proof: [...BIG.proof].reverse() },
    { ...BIG, amount: (BigInt(BIG.amount) + 10n ** 10n).toString() },
    { ...BIG, index: BIG.index + 1 },
  ];
  for (const b of bad) {
    const { air, chain } = setup({ hosts: { '/x': serve({ '1c': shardOf(b) }) } });
    const s = await air.status(BIG.address);
    assert.equal(s.eligible, false);
    assert.equal(s.claimable, false);
    assert.equal(s.reason, 'error');
    assert.equal(s.error.code, 'shard-fetch');
    assert.match(s.error.message, /does not recompute/);
    assert.equal(chain.st.calls.length, 0);
    await refused(air.buildClaim(BIG.address), 'shard-fetch');
  }
});

test('a proof file for a different root, and malformed entries, are errors', async () => {
  const wrongRoot = { '1c': { ...shardOf(BIG), root: '0x' + '00'.repeat(32) } };
  let s = await setup({ hosts: { '/x': serve(wrongRoot) } }).air.status(BIG.address);
  assert.match(s.error.message, /different root/);

  const cases = {
    'no claims map': { root: FX.root },
    'null entry': { root: FX.root, claims: { [BIG.address]: null } },
    'negative index': { root: FX.root, claims: { [BIG.address]: { ...BIG, index: -1 } } },
    'fractional index': { root: FX.root, claims: { [BIG.address]: { ...BIG, index: 1.5 } } },
    'numeric amount': { root: FX.root, claims: { [BIG.address]: { ...BIG, amount: 5 } } },
    'zero amount': { root: FX.root, claims: { [BIG.address]: { ...BIG, amount: '0' } } },
    'hex amount': { root: FX.root, claims: { [BIG.address]: { ...BIG, amount: '0x10' } } },
    'amount past 2^256': { root: FX.root, claims: { [BIG.address]: { ...BIG, amount: '9'.repeat(78) } } },
    'endless amount': { root: FX.root, claims: { [BIG.address]: { ...BIG, amount: '9'.repeat(100000) } } },
    'proof not an array': { root: FX.root, claims: { [BIG.address]: { ...BIG, proof: 'abc' } } },
    'short proof word': { root: FX.root, claims: { [BIG.address]: { ...BIG, proof: [...BIG.proof.slice(0, 12), '0x1234'] } } },
    'oversized proof': { root: FX.root, claims: { [BIG.address]: { ...BIG, proof: Array(65).fill(BIG.proof[0]) } } },
  };
  for (const [name, shard] of Object.entries(cases)) {
    s = await setup({ hosts: { '/x': serve({ '1c': shard }) } }).air.status(BIG.address);
    assert.equal(s.reason, 'error', name);
    assert.equal(s.eligible, false, name);
  }
});

test('the contract has the last word: a proof it does not accept is an error', async () => {
  const { air } = setup({ chain: { root: '0x' + 'ee'.repeat(32) } });
  const s = await air.status(BIG.address);
  assert.equal(s.reason, 'error');
  assert.equal(s.error.code, 'chain-rejects-proof');
  assert.equal(s.claimable, false);
});

test('an RPC on the wrong network is an error, not a claimable allocation', async () => {
  const { air } = setup({ chain: { air: '0x' + '55'.repeat(20) } });
  const s = await air.status(BIG.address);
  assert.equal(s.reason, 'error');
  assert.equal(s.error.code, 'bad-response');
});

// ── failures never throw out of status ──
test('network failures come back as an error field', async () => {
  const boom = async () => { throw new TypeError('Failed to fetch'); };
  let r = makeTacAirdrop({ call: async () => '0x', keccak256: keccak_256, fetchImpl: boom, proofsBase: '/x' });
  let s = await r.status(BIG.address);
  assert.deepEqual([s.eligible, s.reason, s.error.code], [false, 'error', 'shard-fetch']);
  assert.match(s.error.message, /Failed to fetch/);

  for (const res of [http(500), { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }, ok('<html>')]) {
    r = makeTacAirdrop({ call: async () => '0x', keccak256: keccak_256, fetchImpl: async () => res, proofsBase: '/x' });
    s = await r.status(BIG.address);
    assert.equal(s.error.code, 'shard-fetch');
  }

  r = setup({ chain: { failWith: new AirdropError('rpc', 'could not reach Ethereum (rpc 503)') } }).air;
  s = await r.status(BIG.address);
  assert.deepEqual([s.eligible, s.reason, s.error.code], [false, 'error', 'rpc']);
  assert.equal(s.claimable, false);
  assert.match(s.error.message, /rpc 503/);

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    r = makeTacAirdrop({ call: async () => '0x', keccak256: keccak_256, proofsBase: '/x' });
    s = await r.status(BIG.address);
    assert.deepEqual([s.reason, s.error.code], ['error', 'shard-fetch']);
    assert.match(s.error.message, /no fetch implementation/);
  } finally { globalThis.fetch = realFetch; }
});

// ── proof hosts ──
test('the default proof host is the dapp origin, and a trailing slash does not matter', async () => {
  const c = makeChain();
  const log = [];
  const air = makeTacAirdrop({ call: c.call, keccak256: keccak_256, fetchImpl: makeFetch({ '/airdrop/v1/proofs': serve(SHARDS) }, log) });
  assert.deepEqual([...air.config.proofsBase], ['/airdrop/v1/proofs']);
  assert.equal((await air.status(BIG.address)).eligible, true);
  assert.deepEqual(log, ['/airdrop/v1/proofs/1c.json']);
  const slashed = makeTacAirdrop({ call: c.call, keccak256: keccak_256, fetchImpl: makeFetch({ '/p': serve(SHARDS) }, log), proofsBase: '/p///' });
  assert.equal((await slashed.status(BIG.address)).eligible, true);
  assert.equal(log[1], '/p/1c.json');
  assert.deepEqual(PUBLIC_PROOF_HOSTS, [PROOF_HOSTS.cdn, PROOF_HOSTS.mirror]);
  assert.match(PROOF_HOSTS.cdn, /^https:\/\/cdn\.jsdelivr\.net\/gh\/z0r0z\/tacit@[0-9a-f]{40}\/dapp\/airdrop\/v1\/proofs$/);
  assert.match(PROOF_HOSTS.mirror, /^https:\/\/raw\.githubusercontent\.com\/z0r0z\/tacit\/[0-9a-f]{40}\/dapp\/airdrop\/v1\/proofs$/);
});

test('hosts are tried in order: a failing, missing or lying host hands over to the next', async () => {
  const good = serve(SHARDS);
  const tampered = serve({ '1c': shardOf({ ...BIG, amount: (BigInt(BIG.amount) * 2n).toString() }) });
  const fail = () => { throw new TypeError('Failed to fetch'); };
  const cases = [
    [{ A: () => http(500), B: good }, ['A/1c.json', 'B/1c.json']],
    [{ A: fail, B: good }, ['A/1c.json', 'B/1c.json']],
    [{ A: () => http(404), B: good }, ['A/1c.json', 'A/manifest.json', 'B/1c.json']],   // no manifest to vouch for the 404: try the next
    [{ A: tampered, B: good }, ['A/1c.json', 'B/1c.json']],
    [{ A: good, B: () => http(500) }, ['A/1c.json']],
  ];
  for (const [hosts, expectFetched] of cases) {
    const { air, fetchLog } = setup({ hosts, proofsBase: Object.keys(hosts) });
    const s = await air.status(BIG.address);
    assert.equal(s.eligible, true, JSON.stringify(expectFetched));
    assert.equal(s.amountWei, BIG.amount);
    assert.deepEqual(fetchLog, expectFetched);
  }
});

test('hosts: unlisted only when every host says no such file; a host that errors makes it an error', async () => {
  const unlisted = '0x77' + '22'.repeat(19);
  let r = setup({ hosts: { A: serve(SHARDS), B: serve(SHARDS) }, proofsBase: ['A', 'B'] });
  assert.equal((await r.air.status(unlisted)).reason, 'not-listed');
  assert.deepEqual(r.fetchLog, ['A/77.json', 'A/manifest.json', 'B/77.json', 'B/manifest.json']);

  r = setup({ hosts: { A: () => http(404), B: () => http(500) }, proofsBase: ['A', 'B'] });
  let s = await r.air.status(unlisted);
  assert.equal(s.reason, 'error');
  assert.equal(s.error.code, 'shard-fetch');
  assert.match(s.error.message, /B\/77\.json: HTTP 500/);

  r = setup({ hosts: { A: () => http(500), B: () => http(404) }, proofsBase: ['A', 'B'] });
  assert.equal((await r.air.status(unlisted)).reason, 'error');

  r = setup({ hosts: {}, proofsBase: [] });
  s = await r.air.status(BIG.address);
  assert.equal(s.error.code, 'no-proof-host');

  // a file that is served and lacks the address is the answer; later hosts are not asked
  r = setup({ hosts: { A: serve({ '1c': shardOf(DUST) }), B: serve(SHARDS) }, proofsBase: ['A', 'B'] });
  assert.equal((await r.air.status(BIG.address)).reason, 'not-listed');
  assert.deepEqual(r.fetchLog, ['A/1c.json']);
});

test('a 404 means "not listed" only when the manifest says the airdrop has no such file', async () => {
  const unlisted = '0x77' + '22'.repeat(19);
  const isError = async (hosts, re) => {
    const s = await setup({ hosts, proofsBase: Object.keys(hosts) }).air.status(unlisted);
    assert.equal(s.reason, 'error');
    assert.equal(s.eligible, false);
    assert.equal(s.error.code, 'shard-fetch');
    assert.match(s.error.message, re);
  };
  // the host serves the manifest and it has no such byte
  assert.equal((await setup().air.status(unlisted)).reason, 'not-listed');
  // a host that serves nothing (a wrong base URL, a deploy without the files) is an error, never "not eligible"
  await isError({ '/x': () => http(404) }, /the manifest cannot say/);
  // the manifest lists the byte but the file is not served
  await isError({ '/x': (xx) => (xx === 'manifest' ? ok({ root: FX.root, shards: ['77'] }) : http(404)) }, /in the manifest but not served/);
  // a manifest of another airdrop, or one that is not a manifest, says nothing
  await isError({ '/x': (xx) => (xx === 'manifest' ? ok({ root: '0x' + '00'.repeat(32), shards: [] }) : http(404)) }, /not the airdrop manifest/);
  await isError({ '/x': (xx) => (xx === 'manifest' ? ok({ root: FX.root }) : http(404)) }, /not the airdrop manifest/);
  await isError({ '/x': (xx) => (xx === 'manifest' ? http(500) : http(404)) }, /HTTP 500/);
  // the manifest is fetched once
  const r = setup();
  await r.air.status(unlisted);
  await r.air.status('0x78' + '22'.repeat(19));
  assert.equal(r.fetchLog.filter((u) => u.endsWith('manifest.json')).length, 1);
});

test('a proof file is fetched once, and a failed fetch is not remembered', async () => {
  let { air, fetchLog } = setup();
  await air.status(BIG.address);
  await air.status(BIG.address);
  await air.status('0x1c' + '11'.repeat(19));
  assert.deepEqual(fetchLog, ['/x/1c.json']);

  let up = false;
  const fetchImpl = async () => (up ? ok(SHARDS['1c']) : http(503));
  const c = makeChain();
  air = makeTacAirdrop({ call: c.call, keccak256: keccak_256, fetchImpl, proofsBase: '/x' });
  assert.equal((await air.status(BIG.address)).reason, 'error');
  up = true;
  assert.equal((await air.status(BIG.address)).eligible, true);
});

// ── networks without the airdrop ──
test('a network without the airdrop says so, and reads nothing', async () => {
  const c = makeChain();
  const fetchLog = [];
  const air = makeTacAirdrop({ call: c.call, keccak256: keccak_256, fetchImpl: makeFetch({ '/x': serve(SHARDS) }, fetchLog), proofsBase: '/x', chainId: 11155111 });
  assert.equal(air.config.deployed, false);
  assert.equal(air.config.address, null);
  const s = await air.status(BIG.address);
  assert.deepEqual([s.deployed, s.eligible, s.claimable, s.reason], [false, false, false, 'not-deployed']);
  assert.match(s.message, /not deployed on this network/);
  assert.equal(s.error, undefined);
  assert.deepEqual([c.st.calls.length, fetchLog.length], [0, 0]);
  for (const p of [air.buildClaim(BIG.address), air.buildClaimTo(BIG.address, FX.to), air.buildClaimAndShield(BIG.address, FX.commit), air.claim(BIG.address, { send: async () => '0x' }), air.entryFor(BIG.address)]) {
    await refused(p, 'not-deployed');
  }
  assert.equal(makeTacAirdrop({ call: c.call, keccak256: keccak_256, chainId: '1' }).config.deployed, true, 'a chain id given as a string');
});

test('the pinned deployment is the one in the docs', () => {
  assert.equal(D.address, '0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8');
  assert.equal(D.root, FX.root);
  assert.equal(D.deadline, 1797803449);
  assert.equal(D.token, '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279');
  assert.equal(D.decimals, 18);
  assert.equal(D.unitScale, '10000000000');
  const { air } = setup();
  assert.equal(air.config.root, FX.root);
  assert.equal(air.config.claimByISO, '2026-12-20T21:50:49Z');
  assert.throws(() => { air.config.address = 'x'; }, TypeError, 'config is frozen');
});

// ── calldata ──
test('calldata equals what cast calldata produces', async () => {
  const { air } = setup();
  const claim0 = await air.buildClaim(BIG.address);
  assert.deepEqual(claim0, { to: AIR, data: FX.vectors.claim0, value: '0x0' });
  assert.equal((await air.buildClaim(MID.address)).data, FX.vectors.claim1, 'a 14-word proof');
  assert.deepEqual(await air.buildClaimTo(BIG.address, FX.to), { from: BIG.address, to: AIR, data: FX.vectors.claimTo0, value: '0x0' });
  assert.deepEqual(await air.buildClaimAndShield(BIG.address, FX.commit), { from: BIG.address, to: AIR, data: FX.vectors.claimAndShield0, value: '0x0' });
  // the four selectors are the signatures' keccak
  assert.equal(claim0.data.slice(2, 10), S.claim);
  assert.equal(FX.vectors.claimTo0.slice(2, 10), S.claimTo);
  assert.equal(FX.vectors.claimAndShield0.slice(2, 10), S.claimAndShield);
  assert.equal(FX.vectors.verify0.slice(2, 10), S.verify);
  assert.equal(FX.vectors.isClaimed0.slice(2, 10), S.isClaimed);
  assert.equal(FX.vectors.aggregate3State0.slice(2, 10), S.aggregate3);
  assert.equal(S.claim, '2e7ba6ef');
  assert.equal(S.claimTo, '4f54d47c');
  assert.equal(S.claimAndShield, 'ad8b9781');
});

test('calldata layout, decoded by hand', async () => {
  const { air } = setup();
  const { data } = await air.buildClaim(MID.address);
  assert.equal(argNum(data, 0), 52n);
  assert.equal(argAddr(data, 1), MID.address);
  assert.equal(argNum(data, 2), BigInt(MID.amount));
  assert.equal(argNum(data, 3), 0x80n);
  assert.deepEqual(argProof(data, 4), MID.proof);
  assert.equal(data.length, 2 + 8 + 64 * (5 + MID.proof.length));
});

test('claimTo refuses recipients the contract would refuse, and bad addresses', async () => {
  const { air } = setup();
  for (const to of ['0x' + '00'.repeat(20), AIR, lc(AIR), TOKEN, POOL]) await refused(air.buildClaimTo(BIG.address, to), 'bad-recipient');
  await refused(air.buildClaimTo(BIG.address, 'junk'), 'bad-address');
  await refused(air.buildClaimTo('junk', FX.to), 'bad-address');
  await refused(air.buildClaimTo('0x' + '77'.repeat(20), FX.to), 'not-listed');
});

test('a shield commit must be 32 bytes and not zero', async () => {
  const { air } = setup();
  await refused(air.buildClaimAndShield(BIG.address, '0x' + '00'.repeat(32)), 'zero-commit');
  for (const c of ['0x1234', '', null, '0x' + 'ab'.repeat(31), '0x' + 'zz'.repeat(32)]) await refused(air.buildClaimAndShield(BIG.address, c), 'bad-commit');
  assert.equal((await air.buildClaimAndShield(BIG.address, FX.commit.toUpperCase().replace('0X', '0x'))).data.slice(2, 10), S.claimAndShield);
});

// ── makeRpcCall ──
test('makeRpcCall: request shape, revert data, failover', async () => {
  const seen = [];
  const answers = {
    good: { result: '0x01' },
    revert: { error: { code: 3, message: 'execution reverted', data: '0x' + ERR.AlreadyClaimed } },
    revertNoCode: { error: { code: -32000, message: 'execution reverted: x', data: '0xdeadbeef' } },
    nodeError: { error: { code: -32000, message: 'header not found' } },
  };
  const f = (kind) => async (url, opts) => { seen.push({ url, opts, body: JSON.parse(opts.body) }); if (kind === 'http500') return { ok: false, status: 500 }; return { ok: true, json: async () => answers[kind] }; };
  const at = (map) => async (url, opts) => f(map[url])(url, opts);

  let call = makeRpcCall({ rpcs: ['a'], fetchImpl: f('good') });
  assert.equal(await call({ to: AIR, data: '0x9e34070f', from: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD' }), '0x01');
  assert.deepEqual(seen[0].body, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: lc(AIR), data: '0x9e34070f', from: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' }, 'latest'] });
  assert.equal(seen[0].opts.method, 'POST');
  await call({ to: AIR, data: '0x' });
  assert.equal('from' in seen[1].body.params[0], false);

  call = makeRpcCall({ rpcs: ['a', 'b'], fetchImpl: f('revert') });
  await assert.rejects(call({ to: AIR, data: '0x' }), (e) => e.code === 3 && e.data === '0x' + ERR.AlreadyClaimed && /reverted/.test(e.message));
  assert.equal(seen.filter((s) => s.url === 'b').length, 0, 'a revert is definitive: no second endpoint');

  call = makeRpcCall({ rpcs: ['a'], fetchImpl: f('revertNoCode') });
  await assert.rejects(call({ to: AIR, data: '0x' }), (e) => e.code === 3 && e.data === '0xdeadbeef');

  seen.length = 0;
  call = makeRpcCall({ rpcs: ['a', 'b', 'c', 'd'], fetchImpl: at({ a: 'http500', b: 'nodeError', c: 'good', d: 'revert' }) });
  assert.equal(await call({ to: AIR, data: '0x' }), '0x01');
  assert.deepEqual(seen.map((s) => s.url), ['a', 'b', 'c']);

  call = makeRpcCall({ rpcs: ['a', 'b'], fetchImpl: at({ a: 'http500', b: 'nodeError' }) });
  await assert.rejects(call({ to: AIR, data: '0x' }), (e) => e instanceof AirdropError && e.code === 'rpc' && /header not found/.test(e.message));
  call = makeRpcCall({ rpcs: ['a'], fetchImpl: async () => { throw new TypeError('offline'); } });
  await assert.rejects(call({ to: AIR, data: '0x' }), (e) => e.code === 'rpc' && /offline/.test(e.message));
  await assert.rejects(makeRpcCall({ rpcs: [], fetchImpl: f('good') })({ to: AIR, data: '0x' }), (e) => e.code === 'rpc' && /no RPC endpoint/.test(e.message));
  await assert.rejects(makeRpcCall({ fetchImpl: f('good') })({ to: AIR, data: '0x' }), (e) => e.code === 'rpc');
});

// ── sending ──
test('claim: simulated first, then handed to the wallet, and any sender may send it', async () => {
  const { air, chain } = setup();
  const s = sender();
  const r = await air.claim(BIG.address, { send: s.send });
  assert.equal(r.txHash, '0x' + 'cd'.repeat(32));
  assert.deepEqual(s.sent, [{ to: AIR, data: FX.vectors.claim0, value: '0x0' }]);
  assert.deepEqual([r.index, r.amountWei], [978, BIG.amount]);
  const last = chain.st.calls[chain.st.calls.length - 1];
  assert.equal(last.data, FX.vectors.claim0, 'the claim was simulated');
  assert.equal(last.from, undefined);

  const sponsor = '0x' + '5a'.repeat(20);
  const s2 = sender();
  await air.claim(BIG.address, { send: s2.send, from: sponsor });
  assert.equal(s2.sent[0].from, sponsor);
  assert.equal(chain.st.calls[chain.st.calls.length - 1].from, sponsor);
  assert.equal(s2.sent[0].data, FX.vectors.claim0, 'the same call, whoever sends it');
});

test('claim uses the factory-level send when none is passed, and refuses without one', async () => {
  const s = sender();
  await setup({ send: s.send }).air.claim(BIG.address);
  assert.equal(s.sent.length, 1);
  await refused(setup().air.claim(BIG.address), 'no-sender');
  await refused(setup().air.claim(BIG.address, { send: 'nope' }), 'no-sender');
});

test('claimTo: from the recipient, to the chosen address', async () => {
  const { air, chain } = setup();
  const s = sender();
  const r = await air.claimTo(BIG.address, FX.to, { send: s.send });
  assert.deepEqual(s.sent, [{ from: BIG.address, to: AIR, data: FX.vectors.claimTo0, value: '0x0' }]);
  assert.equal(r.txHash.length, 66);
  assert.equal(chain.st.calls[chain.st.calls.length - 1].from, BIG.address, 'simulated from the recipient');
  await refused(air.claimTo(BIG.address, POOL, { send: s.send }), 'bad-recipient');
  assert.equal(s.sent.length, 1);
});

test('the send helpers refuse a claim that cannot go through, before asking the wallet', async () => {
  const cases = [
    ['claimed', { claimed: new Set([978]) }],
    ['paused', { paused: true }],
    ['closed', { timestamp: D.deadline + 1 }],
    ['unfunded', { balance: 1n }],
  ];
  for (const [code, chain] of cases) {
    const { air } = setup({ chain });
    const s = sender();
    await refused(air.claim(BIG.address, { send: s.send }), code);
    await refused(air.claimTo(BIG.address, FX.to, { send: s.send }), code);
    assert.equal(s.sent.length, 0, code);
  }
  const { air } = setup();
  const s = sender();
  await refused(air.claim('0x' + '77'.repeat(20), { send: s.send }), 'not-listed');
  await refused(air.claim('junk', { send: s.send }), 'bad-address');
  assert.equal(s.sent.length, 0);
  await assert.rejects(setup({ chain: { failWith: new AirdropError('rpc', 'down') } }).air.claim(BIG.address, { send: s.send }), (e) => e.code === 'rpc');
});

test('a claim the contract would revert is not sent, and the reason is named', async () => {
  // the state read says claimable, then the contract reverts (a claim landed in between)
  for (const [name, code] of [['Paused', 'paused'], ['ClaimWindowClosed', 'closed'], ['AlreadyClaimed', 'claimed'], ['BadProof', 'bad-proof'], ['BadRecipient', 'bad-recipient']]) {
    const { air } = setup({ chain: { forceRevert: ERR[name] } });
    const s = sender();
    await assert.rejects(air.claim(BIG.address, { send: s.send }), (e) => e instanceof AirdropError && e.code === code && /Nothing was sent/.test(e.message) && e.data === '0x' + ERR[name], name);
    assert.equal(s.sent.length, 0, name);
  }
  const { air } = setup({ chain: { forceRevert: 'deadbeef' } });
  const s = sender();
  await assert.rejects(air.claim(BIG.address, { send: s.send }), (e) => e.code === 'simulation-failed' && /0xdeadbeef/.test(e.message) && e.data === '0xdeadbeef');
  assert.equal(s.sent.length, 0);
});

test('a simulation that cannot run stops the send, and a wallet that fails is the wallet\'s error', async () => {
  const sim = setup();
  const s = sender();
  const origCall = sim.chain.call;
  let n = 0;
  const air = makeTacAirdrop({
    call: async (a) => { if (++n > 1) throw new AirdropError('rpc', 'could not reach Ethereum'); return origCall(a); },
    keccak256: keccak_256, fetchImpl: makeFetch({ '/x': serve(SHARDS) }), proofsBase: '/x',
  });
  await assert.rejects(air.claim(BIG.address, { send: s.send }), (e) => e.code === 'rpc' && /Nothing was sent/.test(e.message));
  assert.equal(s.sent.length, 0);

  const rejected = Object.assign(new Error('User rejected the request.'), { code: 4001 });
  await assert.rejects(setup().air.claim(BIG.address, { send: async () => { throw rejected; } }), (e) => e === rejected);
});

test('waitClaimed: polls the chain until the allocation reads as claimed', async () => {
  let polls = 0;
  const sleeps = [];
  const { air } = setup({ chain: { claimed: { has: () => ++polls > 3 } }, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await air.waitClaimed(BIG.address), { claimed: true });
  assert.equal(polls, 4);
  assert.deepEqual(sleeps, [4000, 4000, 4000]);
});

test('waitClaimed: gives up after the limit, and rides over a failing poll', async () => {
  const sleeps = [];
  let flaky = 0;
  const c = makeChain();
  const call = async (a) => { if (a.data.slice(2, 10) === S.isClaimed && flaky++ < 2) throw new Error('rpc 502'); return c.call(a); };
  const air = makeTacAirdrop({ call, keccak256: keccak_256, fetchImpl: makeFetch({ '/x': serve(SHARDS) }), proofsBase: '/x', sleep: async (ms) => { sleeps.push(ms); } });
  const r = await air.waitClaimed(BIG.address, { timeoutMs: 20000, intervalMs: 5000 });
  assert.deepEqual([r.claimed, r.timedOut], [false, true]);
  assert.equal(sleeps.length, 4);
  assert.equal(r.error, null, 'the last poll succeeded');

  const down = makeTacAirdrop({ call: async () => { throw new Error('offline'); }, keccak256: keccak_256, fetchImpl: makeFetch({ '/x': serve(SHARDS) }), proofsBase: '/x', sleep: async () => {} });
  const d = await down.waitClaimed(BIG.address, { timeoutMs: 100, intervalMs: 50 });
  assert.deepEqual([d.claimed, d.timedOut, d.error], [false, true, 'offline']);
  await refused(setup().air.waitClaimed('0x' + '77'.repeat(20)), 'not-listed');
});

// ── shielding ──
const WALLET = '0x' + '22'.repeat(32);
const DEPLOY_BLOCK = getConfidentialDeployment('mainnet').deployBlock;
function realUx() {
  return makeConfidentialPoolUx({
    secp, keccak256: keccak_256, sha256, network: 'mainnet',
    fetchImpl: async (_u, opts) => {
      const b = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ result: b.method === 'eth_blockNumber' ? '0x' + DEPLOY_BLOCK.toString(16) : [] }) };
    },
  });
}
function shieldSetup(chain) {
  const ux = realUx();
  const settled = [];
  const facade = { cfg: ux.cfg, assetByTicker: ux.assetByTicker, buildWrap: ux.buildWrap, nextWrapIndex: ux.nextWrapIndex, submitWrapSettle: async (a) => { settled.push(a); return { status: 'settled' }; } };
  return { ...setup({ chain, ux: facade }), ux, facade, settled };
}

test('shieldPlan refuses unless the unproven step is acknowledged', async () => {
  const { air } = shieldSetup();
  await refused(air.shieldPlan({ walletPriv: WALLET, address: BIG.address }), 'shield-unproven');
  await refused(air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: false }), 'shield-unproven');
});

test('shieldPlan: the commit comes from the pool ux for the wallet key, and the record holds no secret', async () => {
  const { air, ux } = shieldSetup();
  const plan = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true });
  assert.equal(plan.kind, 'tac-airdrop-shield');
  const again = ux.buildWrap({ walletPriv: WALLET, amountWei: BIG.amount, ticker: 'TAC', index: plan.record.wrapIndex });
  assert.equal(plan.record.commit, again.commit, 'the wrap is deterministic in (key, asset, index)');
  assert.equal(plan.record.commit, plan.built.commit);
  assert.equal(plan.record.depositId, plan.built.depositId);
  assert.match(plan.record.commit, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(plan.tx, await air.buildClaimAndShield(BIG.address, plan.built.commit));
  assert.equal(plan.tx.from, BIG.address);
  assert.equal(plan.tx.data.slice(2, 10), S.claimAndShield);
  assert.equal(lc(plan.built.wrapArgs.assetId), D.assetId);
  assert.equal(plan.built.wrapArgs.amount, BIG.amount);
  assert.deepEqual(plan.record, {
    contract: AIR, pool: POOL, account: BIG.address, airdropIndex: 978, amountWei: BIG.amount,
    wrapIndex: plan.record.wrapIndex, commit: plan.built.commit, depositId: plan.built.depositId,
  });
  const json = JSON.stringify(plan.record);
  for (const secret of [plan.built.note.blinding, plan.built.note.secret]) assert.ok(!json.toLowerCase().includes(String(secret).replace(/^0x/, '').toLowerCase()), 'no note secret in the record');
});

test('shieldPlan takes the next unused wrap index, or the one given', async () => {
  const { air } = shieldSetup();
  const a = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true });
  const b = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true });
  assert.deepEqual([a.record.wrapIndex, b.record.wrapIndex], [0, 1]);
  assert.notEqual(a.record.commit, b.record.commit);
  const c = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true, index: 7 });
  assert.equal(c.record.wrapIndex, 7);
});

test('shieldPlan: a different wallet key gives a different commit for the same allocation', async () => {
  const { air } = shieldSetup();
  const a = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true, index: 0 });
  const b = await air.shieldPlan({ walletPriv: '0x' + '33'.repeat(32), address: BIG.address, allowUnproven: true, index: 0 });
  assert.notEqual(a.record.commit, b.record.commit);
});

test('shieldPlan refuses what cannot be shielded, before deriving anything', async () => {
  for (const [code, chain] of [['claimed', { claimed: new Set([978]) }], ['paused', { paused: true }], ['closed', { timestamp: D.deadline + 1 }], ['unfunded', { balance: 0n }]]) {
    const { air } = shieldSetup(chain);
    await refused(air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true }), code);
  }
  const { air } = shieldSetup();
  await refused(air.shieldPlan({ walletPriv: WALLET, address: '0x' + '77'.repeat(20), allowUnproven: true }), 'not-listed');

  // sub-unit dust: the ux is never asked for an index
  const t = customSetup(1);
  let asked = 0;
  const ux = { cfg: { pool: POOL }, assetByTicker: {}, buildWrap: () => { asked++; }, nextWrapIndex: async () => { asked++; return 0; }, submitWrapSettle: async () => {} };
  await refused(t.air.shieldPlan({ ux, walletPriv: WALLET, address: t.entry.address, allowUnproven: true }), 'not-aligned');
  assert.equal(asked, 0);
});

test('shieldPlan needs the pool ux, on the pool the airdrop deposits into, for the airdrop asset', async () => {
  const { air, facade } = shieldSetup();
  const ask = (ux) => air.shieldPlan({ ux, walletPriv: WALLET, address: BIG.address, allowUnproven: true });
  await refused(ask(null), 'no-ux');
  await refused(ask({ ...facade, buildWrap: undefined }), 'no-ux');
  await refused(ask({ ...facade, cfg: { pool: '0x' + '99'.repeat(20) } }), 'pool-mismatch');
  await refused(ask({ ...facade, cfg: undefined }), 'pool-mismatch');
  await refused(ask({ ...facade, buildWrap: (a) => ({ ...facade.buildWrap(a), wrapArgs: { ...facade.buildWrap(a).wrapArgs, assetId: '0x' + '11'.repeat(32) } }) }), 'asset-mismatch');
  await refused(ask({ ...facade, buildWrap: (a) => ({ ...facade.buildWrap(a), wrapArgs: { ...facade.buildWrap(a).wrapArgs, amount: '1' } }) }), 'asset-mismatch');
  await refused(ask({ ...facade, buildWrap: (a) => ({ ...facade.buildWrap(a), commit: '0x' + '00'.repeat(32) }) }), 'zero-commit');
});

test('claimAndShield sends the plan from the recipient, after reading the status again', async () => {
  const { air, chain } = shieldSetup();
  const plan = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true });
  const s = sender();
  const r = await air.claimAndShield(plan, { send: s.send });
  assert.deepEqual(s.sent, [plan.tx]);
  assert.equal(r.txHash.length, 66);
  assert.equal(chain.st.calls[chain.st.calls.length - 1].from, BIG.address, 'simulated from the recipient');

  // a claim by someone else lands first: the shield is refused, the recipient already holds plain TAC
  chain.st.claimed.add(978);
  const s2 = sender();
  await refused(air.claimAndShield(plan, { send: s2.send }), 'claimed');
  assert.equal(s2.sent.length, 0);
});

test('claimAndShield only sends what shieldPlan made', async () => {
  const { air } = shieldSetup();
  const plan = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true });
  const s = sender();
  for (const bad of [null, {}, { kind: 'other', record: plan.record }, { kind: plan.kind, tx: plan.tx }]) await refused(air.claimAndShield(bad, { send: s.send }), 'bad-plan');
  await refused(air.claimAndShield({ ...plan, record: { ...plan.record, airdropIndex: 5 } }, { send: s.send }), 'bad-plan');
  await refused(air.claimAndShield({ ...plan, record: { ...plan.record, amountWei: '1' } }, { send: s.send }), 'bad-plan');
  await refused(air.claimAndShield({ ...plan, record: { ...plan.record, commit: '0x' + '00'.repeat(32) } }, { send: s.send }), 'zero-commit');
  // the transaction is rebuilt from the verified entry and the recorded commit, whatever `tx` says
  const forged = { ...plan, tx: { ...plan.tx, to: '0x' + '66'.repeat(20), data: '0xdeadbeef' } };
  await air.claimAndShield(forged, { send: s.send });
  assert.deepEqual(s.sent, [plan.tx]);
});

test('settleShield: settles a pending deposit, from the plan or from the record and the key alone', async () => {
  const { air, chain, settled } = shieldSetup();
  const plan = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true });

  // not on the pool yet
  await refused(air.settleShield({ walletPriv: WALLET, record: plan.record }), 'deposit-not-found');
  assert.equal(settled.length, 0);
  const poll = chain.st.calls[chain.st.calls.length - 1];
  assert.equal(poll.to, lc(POOL));
  assert.equal(poll.data, '0x' + S.depositStatus + plan.record.depositId.slice(2));

  chain.st.deposits.set(plan.record.depositId, 1);
  const r1 = await air.settleShield({ walletPriv: WALLET, record: plan.record, built: plan.built, waitOpts: { tries: 3 } });
  assert.deepEqual([r1.settled, r1.alreadySettled, r1.result], [true, false, { status: 'settled' }]);
  assert.equal(settled[0].built, plan.built);
  assert.deepEqual(settled[0].waitOpts, { tries: 3 });

  // after a reload only the record and the wallet key remain
  const stored = JSON.parse(JSON.stringify(plan.record));
  const r2 = await air.settleShield({ walletPriv: WALLET, record: stored });
  assert.equal(r2.settled, true);
  assert.equal(settled[1].built.commit, plan.record.commit);
  assert.equal(settled[1].built.depositId, plan.record.depositId);
  assert.equal(settled[1].built.wrapOp.value, String(BigInt(BIG.amount) / 10n ** 10n));
});

test('settleShield: an already settled deposit is left alone, and a wrong key or record is refused', async () => {
  const { air, chain, settled } = shieldSetup();
  const plan = await air.shieldPlan({ walletPriv: WALLET, address: BIG.address, allowUnproven: true });
  chain.st.deposits.set(plan.record.depositId, 2);
  assert.deepEqual(await air.settleShield({ walletPriv: WALLET, record: plan.record }), { settled: true, alreadySettled: true });
  assert.equal(settled.length, 0);

  chain.st.deposits.set(plan.record.depositId, 1);
  await refused(air.settleShield({ walletPriv: '0x' + '33'.repeat(32), record: plan.record }), 'wrong-key');
  await refused(air.settleShield({ walletPriv: WALLET, record: { ...plan.record, pool: '0x' + '99'.repeat(20) } }), 'pool-mismatch');
  for (const bad of [null, {}, { ...plan.record, depositId: '0x12' }, { ...plan.record, commit: undefined }]) await refused(air.settleShield({ walletPriv: WALLET, record: bad }), 'bad-record');
  assert.equal(settled.length, 0);
});

// ── the pool ux wiring ──
test('the pool ux exposes the airdrop as tacAirdrop and leaves the stealth airdrop alone', async () => {
  const ux = realUx();
  assert.equal(typeof ux.tacAirdrop.status, 'function');
  assert.equal(ux.tacAirdrop.config.address, AIR);
  assert.equal(ux.tacAirdrop.config.chainId, 1);
  assert.deepEqual([...ux.tacAirdrop.config.proofsBase], ['/airdrop/v1/proofs']);
  assert.equal(typeof ux.airdrop.sealStealthMemo, 'function', 'ux.airdrop is still the stealth airdrop');
  assert.equal(ux.airdrop.status, undefined);
  // shielding is only possible while the dapp's pool is the pool the airdrop deposits into
  assert.equal(lc(ux.cfg.pool), lc(D.pool));
  assert.equal(lc(ux.assetByTicker.TAC.assetId), D.assetId);

  const signet = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'signet', fetchImpl: async () => { throw new Error('offline'); } });
  const s = await signet.tacAirdrop.status(BIG.address);
  assert.deepEqual([s.deployed, s.eligible, s.reason], [false, false, 'not-deployed']);
});

test('the pool ux airdrop reads through its own RPC list and the same-origin proofs', async () => {
  const c = makeChain();
  const seen = [];
  const ux = makeConfidentialPoolUx({
    secp, keccak256: keccak_256, sha256, network: 'mainnet',
    fetchImpl: async (url, opts) => {
      seen.push(url);
      if (opts && opts.body) { const b = JSON.parse(opts.body); assert.equal(b.method, 'eth_call'); return { ok: true, json: async () => ({ result: await c.call({ to: b.params[0].to, data: b.params[0].data, from: b.params[0].from }) }) }; }
      return serve(SHARDS)(/([0-9a-f]{2})\.json$/.exec(url)[1]);
    },
  });
  const s = await ux.tacAirdrop.status(BIG.address);
  assert.equal(s.claimable, true);
  assert.equal(s.amountTac, '216176.40819258');
  assert.equal(seen[0], '/airdrop/v1/proofs/1c.json');
  assert.ok(getConfidentialDeployment('mainnet').rpcs.includes(seen[1]));
});
