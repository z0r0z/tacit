// Key-only recovery: notes and positions a wallet finds again from its private key plus public chain data, with no memo
// and no local record. Each scene builds the chain events a real settle would emit (mock event streams, mock RPC) and
// checks what balance() / farmPositions() / recover() surface, and what they leave unresolved.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';
import { makeConfidentialRecovery, derivePositionOwnerPriv } from '../dapp/confidential-recovery.js';
import { makeCbtcNoteRecovery } from '../dapp/cbtc-note-recovery.js';
import { makeBridgeMintRecovery } from '../dapp/bridge-mint-recovery.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import { bppGens, G as BPP_G } from '../dapp/bulletproofs-plus.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
const { encodeAbiParameters } = await import('../worker-relay/node_modules/viem/_esm/index.js');

const CFG = getConfidentialDeployment('mainnet');
const FARM = CFG.farm;
const MANAGER = FARM.manager.toLowerCase();
const ZERO32 = '0x' + '00'.repeat(32);
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const sel = (sig) => Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex').slice(0, 8);
const evLog = makeConfidentialEvmLog({ keccak256: keccak_256 });
const walletPriv = '0x' + '7a'.repeat(32);
const otherPriv = '0x' + '7b'.repeat(32);
const tx = (n) => '0x' + String(n).padStart(64, '0');
const hexOf = (b) => '0x' + Buffer.from(b).toString('hex');

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

// A note owned by `priv` for `asset` at derivation `index` (the wrap derivation), with its leaf.
function derivedNote(ux, priv, asset, index, value) {
  const id = ux.identity(priv);
  const dn = ux.pool.deriveNote(id.priv, asset, index);
  const blinding = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
  const owner = ux.pool.nkToOwner(dn.secret);
  const c = ux.pool.commitXY(BigInt(value), blinding);
  return { asset, value: BigInt(value), blinding, secret: dn.secret, owner, ...c, leaf: ux.pool.leaf(asset, c.cx, c.cy, owner) };
}
const sealTo = (ux, priv, n, seed = 5n) => ux.memo.encodeMemo(ux.memo.sealMemo(ux.identity(priv).pubHex, n, () => seed));
const leavesEv = (first, leaves, memos, txHash) => ({ type: 'LeavesInserted', firstLeafIndex: first, leaves, memos: memos || leaves.map(() => '0x'), txHash });
const nullifiersEv = (nullifiers, txHash) => ({ type: 'NullifiersSpent', nullifiers, txHash });
const noFlags = { cbtc: false, farm: false, locks: false, cdp: false, deep: false, bridge: false };

// ── raw logs for the balance() path ──
function logsOf(events) {
  return events.map((e, i) => {
    const base = { address: CFG.pool, blockNumber: '0x' + (CFG.deployBlock + 1).toString(16), logIndex: '0x' + i.toString(16), transactionHash: e.txHash || tx(900 + i) };
    if (e.type === 'LeavesInserted') return { ...base, topics: [evLog.TOPIC0.LeavesInserted, '0x' + w(e.firstLeafIndex)], data: encodeAbiParameters([{ type: 'bytes32[]' }, { type: 'bytes[]' }], [e.leaves, e.memos]) };
    if (e.type === 'NullifiersSpent') return { ...base, topics: [evLog.TOPIC0.NullifiersSpent], data: encodeAbiParameters([{ type: 'bytes32[]' }], [e.nullifiers]) };
    if (e.type === 'Wrap') return { ...base, topics: [evLog.TOPIC0.Wrap, e.depositId, e.assetId], data: '0x' + w(e.amount) };
    throw new Error('unsupported test event ' + e.type);
  });
}
function chainHandler(events, extra = async () => undefined) {
  const logs = logsOf(events);
  return async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + (CFG.deployBlock + 10).toString(16);
    if (method === 'eth_getLogs') {
      const t0 = params[0].topics[0];
      return logs.filter((l) => (Array.isArray(t0) ? t0.includes(l.topics[0]) : t0 == null || t0 === l.topics[0]));
    }
    const r = await extra(method, params);
    return r === undefined ? '0x0' : r;
  };
}

// ── ABI encoding of the settle public values, only the fields the walks read ──
function pvBytes(fields) {
  const N = 35, head = new Array(N).fill(w(0)); let tail = '';
  for (const [i, t] of Object.entries(fields)) { head[i] = w(N * 32 + tail.length / 2); tail += t; }
  return '0x' + w(32) + head.join('') + tail;
}
const staticArr = (n, words) => w(n) + words.join('');
const settleInput = (pv) => '0x717fd7f2' + encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes[]' }], [pv, '0x', []]).slice(2);
const addrWord = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
function mintsTail(mints) {
  const elems = mints.map((m) => addrWord(m.controller) + w(m.debtAsset) + w(m.debtValue) + w(m.positionLeaf) + w(m.rateSnapshot) + w(224) + w(m.owner)
    + w(m.legs.length) + m.legs.map((l) => w(l.asset) + w(l.value)).join(''));
  let off = mints.length * 32; const heads = [];
  for (const e of elems) { heads.push(w(off)); off += e.length / 2; }
  return w(mints.length) + heads.join('') + elems.join('');
}

// ── wrap deposits ──
test('balance: a wrap note with an empty memo is found by walking the deposit derivation; a pending deposit is reported, not listed', async () => {
  const ux0 = mkUx();
  const ceth = ux0.assetByTicker.cETH;
  const scale = BigInt(ceth.unitScale);
  const mk = (index, value) => ux0.buildWrap({ walletPriv, amountWei: (BigInt(value) * scale).toString(), ticker: 'cETH', index });
  const w2 = mk(2, 40000), w5 = mk(5, 25000), pending = mk(6, 1000), foreign = ux0.buildWrap({ walletPriv: otherPriv, amountWei: (40000n * scale).toString(), ticker: 'cETH', index: 2 });
  const events = [
    { type: 'Wrap', depositId: w2.depositId, assetId: ceth.assetId, amount: 40000n * scale, txHash: tx(1) },
    { type: 'Wrap', depositId: w5.depositId, assetId: ceth.assetId, amount: 25000n * scale, txHash: tx(2) },
    { type: 'Wrap', depositId: pending.depositId, assetId: ceth.assetId, amount: 1000n * scale, txHash: tx(3) },
    { type: 'Wrap', depositId: foreign.depositId, assetId: ceth.assetId, amount: 40000n * scale, txHash: tx(4) },
    leavesEv(0, [w2.leaf, w5.leaf, foreign.leaf], null, tx(5)),
  ];
  const ux = mkUx(chainHandler(events));
  const b = await ux.balance(walletPriv, { cbtc: false, bridge: false });
  assert.deepEqual(b.notes.map((n) => [n.leafIndex, BigInt(n.value), n.source]), [[0, 40000n, 'wrap'], [1, 25000n, 'wrap']]);
  assert.equal(b.byAsset[ceth.assetId.toLowerCase()].value, 65000n);
  assert.ok(b.notes.every((n) => n.path.length === 32 && n.root && n.nullifier), 'spend-ready: membership path, root and nullifier');
  // The note is a real opening: it re-commits to the leaf on chain.
  assert.equal(ux.pool.leaf(ceth.assetId, b.notes[0].cx, b.notes[0].cy, b.notes[0].owner), w2.leaf);
  const r = await ux.recover({ walletPriv, events, ...noFlags });
  assert.equal(r.diagnostics.notes.viaWrapWalk, 2);
  assert.equal(r.diagnostics.notes.pendingWraps, 1, 'the deposit whose note is not in the tree yet is pending');
  assert.equal((await ux.recover({ walletPriv: otherPriv, events, ...noFlags })).notes.length, 1, 'another wallet finds only its own deposit');
});

test('balance: a spent wrap note is not offered, and a memo-carrying wrap is not duplicated by the walk', async () => {
  const ux0 = mkUx();
  const ceth = ux0.assetByTicker.cETH, scale = BigInt(ceth.unitScale);
  const wr = ux0.buildWrap({ walletPriv, amountWei: (9000n * scale).toString(), ticker: 'cETH', index: 0 });
  const nu = ux0.pool.nativeNu(wr.note.owner, wr.note.secret, wr.leaf);
  const events = [
    { type: 'Wrap', depositId: wr.depositId, assetId: ceth.assetId, amount: 9000n * scale, txHash: tx(1) },
    leavesEv(0, [wr.leaf], [wr.memo], tx(2)), nullifiersEv([nu], tx(3)),
  ];
  const r = await mkUx().recover({ walletPriv, events, ...noFlags });
  assert.equal(r.notes.length, 0);
  const memoOnly = await mkUx().recover({ walletPriv, events: events.slice(0, 2), ...noFlags });
  assert.equal(memoOnly.notes.length, 1);
  assert.equal(memoOnly.notes[0].source, undefined, 'found through its memo, not derived a second time');
});

// The index a wrap uses is reserved and persisted before its deposit is broadcast, so a row of wraps that were
// built and never sent leaves indexes no deposit will ever occupy. The walk carries on through them to whatever
// this device reserved, instead of stopping at the first long gap and calling the wallet empty.
test('balance: a wrap past a run of reserved-but-unbroadcast indexes is found from the index hint this device kept', async () => {
  const ux0 = mkUx();
  const ceth = ux0.assetByTicker.cETH, scale = BigInt(ceth.unitScale);
  const far = ux0.buildWrap({ walletPriv, amountWei: (7000n * scale).toString(), ticker: 'cETH', index: 40 });
  const events = [
    { type: 'Wrap', depositId: far.depositId, assetId: ceth.assetId, amount: 7000n * scale, txHash: tx(1) },
    leavesEv(0, [far.leaf], null, tx(2)),
  ];
  const blind = await mkUx(chainHandler(events)).balance(walletPriv, { cbtc: false, bridge: false });
  assert.equal(blind.notes.length, 0, '40 idle indexes is wider than the run the walk crosses unaided');

  const prior = globalThis.localStorage;
  const store = new Map([[`tacit:next-wrap-index:${ux0.identity(walletPriv).pubHex}:${ceth.assetId.toLowerCase()}`, '41']]);
  globalThis.localStorage = {
    get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
  };
  try {
    const b = await mkUx(chainHandler(events)).balance(walletPriv, { cbtc: false, bridge: false });
    assert.deepEqual(b.notes.map((n) => [BigInt(n.value), n.source]), [[7000n, 'wrap']]);
    const row = b.diag.wrap.scanned.find((x) => String(x.assetId).toLowerCase() === ceth.assetId.toLowerCase());
    assert.equal(row.minIndex, 41, 'the reservation is the floor the walk scans through');
    assert.ok(row.scannedThrough >= 40, 'and how far it got is reported');
    assert.equal(row.lastMatch, 40);
    assert.deepEqual(b.diag.wrap.truncated, [], 'nothing was cut short at maxIndex');
  } finally { globalThis.localStorage = prior; }
});

// A memo is authenticated by the leaf it opens and by nothing else, so a note known only from one is an inbound
// claim: whoever sealed it may have built it and kept its nk. It is labelled until a key channel re-derives it.
test('balance: a note known only from a memo is labelled inbound-unverified; one the wrap walk re-derives is not', async () => {
  const ux0 = mkUx();
  const ceth = ux0.assetByTicker.cETH, scale = BigInt(ceth.unitScale);
  const gift = derivedNote(ux0, otherPriv, ceth.assetId, 0, 1234n); // built under another key, sealed to this wallet
  const wr = ux0.buildWrap({ walletPriv, amountWei: (9000n * scale).toString(), ticker: 'cETH', index: 0 });
  const events = [
    { type: 'Wrap', depositId: wr.depositId, assetId: ceth.assetId, amount: 9000n * scale, txHash: tx(1) },
    leavesEv(0, [gift.leaf, wr.leaf], [sealTo(ux0, walletPriv, gift), wr.memo], tx(2)),
  ];
  const b = await mkUx(chainHandler(events)).balance(walletPriv, { cbtc: false, bridge: false });
  const byLeaf = new Map(b.notes.map((n) => [String(n.leaf).toLowerCase(), n]));
  assert.equal(b.notes.length, 2, 'both are spendable either way');
  assert.equal(byLeaf.get(gift.leaf.toLowerCase()).inboundUnverified, true);
  assert.equal(byLeaf.get(wr.leaf.toLowerCase()).inboundUnverified, false);
  assert.equal(byLeaf.get(wr.leaf.toLowerCase()).keyDerivedBy, 'wrap');
  assert.equal(b.diag.inboundUnverified, 1);
  const r = await mkUx().recover({ walletPriv, events, ...noFlags });
  assert.equal(r.diagnostics.notes.inboundUnverified, 1);
});

// ── bridge-mint destination notes ──
test('balance: a bridge-mint destination note (empty memo) is derived from the wallet key and the burn nullifier', async () => {
  const ux = mkUx();
  const TAC = ux.assetByTicker.TAC.assetId;
  const burnNu = '0x' + '73ee672f'.repeat(8);
  const rec = makeBridgeMintRecovery({ hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n });
  const id = ux.identity(walletPriv);
  const blinding = '0x' + rec.deriveBridgeMintBlinding({ privkey: id.priv, nullifier: burnNu }).toString(16).padStart(64, '0');
  const dn = ux.pool.deriveNote(id.priv, TAC, 0);
  const owner = ux.pool.nkToOwner(dn.secret);
  const VALUE = 100000000000000n; // 1,000,000 TAC in 8-decimal units
  const c = ux.pool.commitXY(VALUE, blinding);
  const leaf = ux.pool.leaf(TAC, c.cx, c.cy, owner);
  const decoy = ux.pool.leaf(TAC, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32));
  const events = [leavesEv(0, [decoy, leaf], null, tx(7)), nullifiersEv([burnNu], tx(7))];
  const ux2 = mkUx(chainHandler(events));
  const b = await ux2.balance(walletPriv, { cbtc: false });
  assert.equal(b.notes.length, 1);
  assert.equal(b.notes[0].leafIndex, 1); assert.equal(BigInt(b.notes[0].value), VALUE); assert.equal(b.notes[0].source, 'bridge-mint');
  assert.equal(b.notes[0].burnNullifier, burnNu);
  assert.equal(b.byAsset[TAC.toLowerCase()].value, VALUE);
  // Another wallet does not see it, and an amount outside the searched set is reported as unresolved rather than mis-found.
  assert.equal((await ux2.balance(otherPriv, { cbtc: false })).notes.length, 0);
  const odd = ux.pool.commitXY(123456789n, blinding);
  const oddLeaf = ux.pool.leaf(TAC, odd.cx, odd.cy, owner);
  const oddEvents = [leavesEv(0, [oddLeaf], null, tx(8)), nullifiersEv([burnNu], tx(8))];
  const missed = await mkUx().recover({ walletPriv, events: oddEvents, ...noFlags, bridge: true });
  assert.equal(missed.notes.length, 0);
  assert.equal(missed.diagnostics.notes.emptyMemoLeavesNotAttributed, 1);
  // ...until the caller supplies the amount.
  const hinted = await mkUx().recover({ walletPriv, events: oddEvents, ...noFlags, bridge: true, bridgeAmounts: [123456789n] });
  assert.equal(hinted.notes.length, 1); assert.equal(hinted.notes[0].leafIndex, 0);
});

// ── cBTC bearer notes ──
test('balance: a cBTC bearer note is found from the wallet key, its funding prevout and the pool lock record', async () => {
  const ux0 = mkUx();
  const asset = ux0.pool.CBTC_ZK_ASSET_ID;
  const rec = makeCbtcNoteRecovery({ hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n });
  const id = ux0.identity(walletPriv);
  const anchor = { txid: 'ab'.repeat(32), vout: 3 };
  const other = { txid: 'cd'.repeat(32), vout: 0 };
  const b = rec.deriveCbtcNoteBlinding({ privkey: id.priv, anchorOutpoint: rec.anchorBytes(anchor.txid, anchor.vout), outputIndex: 0 });
  const c = ux0.pool.commitXY(700n, b);
  const leaf = ux0.pool.leaf(asset, c.cx, c.cy, ZERO32);
  const lock = { txid: 'ef'.repeat(32), vout: 1, value: 700 };
  const outpoint = ux0.pool.outpointKey('0x' + Buffer.from(Buffer.from(lock.txid, 'hex').reverse()).toString('hex'), lock.vout);
  const events = [leavesEv(0, [leaf], null, tx(9))];
  let reads = 0;
  const extra = async (method, params) => {
    if (method !== 'eth_call') return undefined;
    reads++;
    return params[0].data.toLowerCase() === '0x' + sel('cbtcLockVBtc(bytes32)') + outpoint.slice(2) ? '0x' + w(700) : '0x' + w(0);
  };
  const ux = mkUx(chainHandler(events, extra));
  const history = { anchors: [other, anchor], lockOutputs: [lock, { txid: '11'.repeat(32), vout: 0, value: 999 }] };
  const bal = await ux.balance(walletPriv, { btcHistory: history, bridge: false });
  assert.equal(bal.notes.length, 1);
  const n = bal.notes[0];
  assert.equal(BigInt(n.value), 700n); assert.equal(n.source, 'cbtc'); assert.equal(n.owner, ZERO32);
  assert.equal(n.nullifier, ux.pool.nullifier(leaf), 'a bearer note nullifies by its leaf');
  assert.equal(ux.pool.leaf(asset, n.cx, n.cy, n.owner), leaf);
  assert.ok(reads >= 2, 'each candidate lock output is checked against the pool record');
  // No recorded lock value -> nothing to try -> not found (and reported).
  const none = await mkUx(chainHandler(events)).recover({ walletPriv, events, ...noFlags, cbtc: true, btcHistory: history });
  assert.equal(none.cbtc.length, 0);
  assert.equal(none.diagnostics.cbtc.locksRecorded, 0);
  // recover() exposes the cBTC subset.
  const rr = await ux.recover({ walletPriv, events, ...noFlags, cbtc: true, btcHistory: history });
  assert.equal(rr.cbtc.length, 1); assert.equal(rr.diagnostics.notes.viaCbtcScan, 1);
});

// ── send-and-unwrap change ──
test('recover: a send-and-unwrap change note with an empty memo is derived from the spent parent and the settle payout', async () => {
  const ux0 = mkUx();
  const ceth = ux0.assetByTicker.cETH;
  const parent = derivedNote(ux0, walletPriv, ceth.assetId, 0, 90000);
  const parentNu = ux0.pool.nativeNu(parent.owner, parent.secret, parent.leaf);
  const PAY = 30000n, FEE = 1000n;
  const rChange = ux0.pool.deriveOpeningNonce(parent.blinding, parent.cx, 'sendunwrap-change-v1');
  const nk = '0x' + ux0.pool.deriveOpeningNonce(parent.blinding, parent.cx, 'sendunwrap-change-nk-v1').toString(16).padStart(64, '0');
  const owner = ux0.pool.nkToOwner(nk);
  const change = 90000n - PAY - FEE;
  const cc = ux0.pool.commitXY(change, rChange);
  const changeLeaf = ux0.pool.leaf(ceth.assetId, cc.cx, cc.cy, owner);
  const T = tx(11);
  const events = [leavesEv(0, [parent.leaf], [sealTo(ux0, walletPriv, parent)], tx(10)), nullifiersEv([parentNu], T), leavesEv(1, [changeLeaf], null, T)];
  const pv = pvBytes({ 3: staticArr(1, [w(parentNu)]), 6: staticArr(1, [w(ceth.assetId), addrWord('0x' + '5a'.repeat(20)), w(PAY)]), 7: staticArr(1, [w(ceth.assetId), w(FEE)]) });
  const ux = mkUx(async (method, params) => (method === 'eth_getTransactionByHash' && params[0] === T ? { input: settleInput(pv), to: CFG.pool } : undefined));
  const r = await ux.recover({ walletPriv, events, ...noFlags, deep: true });
  assert.equal(r.notes.length, 1, 'the parent is spent; the change is unspent');
  assert.equal(BigInt(r.notes[0].value), change); assert.equal(r.notes[0].source, 'change'); assert.equal(r.notes[0].leafIndex, 1);
  assert.equal(r.notes[0].nullifier, ux0.pool.nativeNu(owner, nk, changeLeaf));
  assert.equal(r.diagnostics.notes.viaChangeWalk, 1);
  // Without the deep walk the wallet still lists nothing for the change: that is reported as an unattributed leaf.
  const shallow = await ux.recover({ walletPriv, events, ...noFlags, deep: false });
  assert.equal(shallow.notes.length, 0); assert.equal(shallow.diagnostics.notes.emptyMemoLeavesNotAttributed, 1);
  assert.equal(shallow.diagnostics.coverage.notes.changeWalk, false);
  // An unreadable settle transaction is reported, never guessed.
  const blind = await mkUx().recover({ walletPriv, events, ...noFlags, deep: true });
  assert.equal(blind.notes.length, 0); assert.equal(blind.diagnostics.change.skipped.length, 1);
});

// ── farm positions ──
function farmScene({ liveShares = 4000n } = {}) {
  const ux0 = mkUx();
  const pool = ux0.pool;
  const P0 = FARM.pools[0];
  const c32 = '0x' + '00'.repeat(12) + MANAGER.slice(2);
  const aNote = derivedNote(ux0, walletPriv, '0x' + '0a'.repeat(32), 0, 5000);
  const pos = ux0.lpBondPosition({ walletPriv, controller: FARM.manager, lpAsset: P0.lpAsset, anchorLeaf: aNote.leaf });
  const derivedReceipt = pool.farmReceiptLeaf(c32, P0.lpAsset, liveShares, pos.owner, pos.nonce);
  // A position under an unrelated key: the wallet key cannot derive it.
  const randomPriv = '0x' + '5c'.repeat(32);
  const randomOwner = '0x' + Buffer.from(secp.getPublicKey(randomPriv.slice(2), true).subarray(1)).toString('hex');
  const randomNonce = '0x' + '9e'.repeat(32);
  const randomShares = 777n;
  const randomReceipt = pool.farmReceiptLeaf(c32, P0.lpAsset, randomShares, randomOwner, randomNonce);
  const foreignReceipt = pool.farmReceiptLeaf(c32, P0.lpAsset, 5n, '0x' + '12'.repeat(32), '0x' + '13'.repeat(32));
  const events = [
    leavesEv(0, [aNote.leaf], [sealTo(ux0, walletPriv, aNote)], tx(20)),
    nullifiersEv([pool.nativeNu(aNote.owner, aNote.secret, aNote.leaf)], tx(21)),
    leavesEv(1, [derivedReceipt], null, tx(21)), { type: 'Bonded', receipt: derivedReceipt, pid: 0, shares: liveShares, unlockAt: 0, txHash: tx(21) },
    leavesEv(2, [randomReceipt], null, tx(22)), { type: 'Bonded', receipt: randomReceipt, pid: 0, shares: randomShares, unlockAt: 0, txHash: tx(22) },
    leavesEv(3, [foreignReceipt], null, tx(23)), { type: 'Bonded', receipt: foreignReceipt, pid: 0, shares: 5n, unlockAt: 0, txHash: tx(23) },
  ];
  const live = new Set([derivedReceipt.toLowerCase(), randomReceipt.toLowerCase(), foreignReceipt.toLowerCase()]);
  const sharesOf = { [derivedReceipt.toLowerCase()]: liveShares, [randomReceipt.toLowerCase()]: randomShares, [foreignReceipt.toLowerCase()]: 5n };
  const handler = async (method, params) => {
    if (method !== 'eth_call') return undefined;
    const { to, data } = params[0];
    if (String(to).toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return '0x'; // no aggregator: per-call fallback
    const s = data.slice(2, 10), arg = ('0x' + data.slice(10, 74)).toLowerCase();
    if (s === '514ea4bf') return '0x' + [0n, sharesOf[arg] || 0n, 0n, 0n, live.has(arg) ? 1n : 0n].map(w).join('');
    if (s === '1808eeb8') return '0x' + w(live.has(arg) ? 2500000000n : 0n);
    if (s === '3717b324') return '0x' + w(0n) + w(1n);
    return '0x0';
  };
  return { ux0, pool, P0, aNote, pos, derivedReceipt, randomReceipt, foreignReceipt, randomPriv, randomOwner, randomNonce, randomShares, events, handler };
}

test('farmPositions: an lpBond position is found from the manager Bonded events and the wallet\'s own spent note; others\' receipts are not listed', async () => {
  const s = farmScene();
  const ux = mkUx(s.handler);
  const found = await ux.farmPositions({ walletPriv, events: s.events });
  assert.equal(found.length, 1);
  assert.equal(found[0].receiptLeaf, s.derivedReceipt); assert.equal(found[0].receiptIndex, 1);
  assert.equal(found[0].anchorLeaf, s.aNote.leaf); assert.equal(found[0].shares, '4000'); assert.equal(found[0].pid, 0);
  assert.ok(!JSON.stringify(found).toLowerCase().includes(s.pos.ownerPriv.slice(2)), 'no receipt key in the result');
  // Without the Bonded events the same wallet finds nothing (its receipt is not an LP-share note it held).
  assert.equal((await ux.farmPositions({ walletPriv, events: s.events.filter((e) => e.type !== 'Bonded') })).length, 0);
  assert.equal((await ux.farmPositions({ walletPriv: otherPriv, events: s.events })).length, 0);
  // A closed position is derived but not listed as live.
  const closed = farmScene();
  const dead = mkUx(async (m, p) => { const r = await closed.handler(m, p); return m === 'eth_call' && String(p[0].data).startsWith('0x514ea4bf') ? '0x' + [0n, 0n, 0n, 0n, 0n].map(w).join('') : r; });
  const diag = {};
  const list = await dead.farmPositions({ walletPriv, events: closed.events, _diag: diag });
  assert.equal(list.length, 0); assert.deepEqual(diag.derivedClosed, [1]);
});

test('importFarmPosition: a saved random-key position is validated against the chain, stored, listed and used to harvest', async () => {
  const s = farmScene();
  const submitted = [];
  const handler = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + (CFG.deployBlock + 10).toString(16);
    if (method === 'eth_getLogs') return logsOf(s.events.filter((e) => e.type !== 'Bonded'));
    return s.handler(method, params);
  };
  const ux = mkUx(handler, { http: async (url, b) => {
    const obj = String(url).includes('/confidential/submit') ? (submitted.push(b), { jobId: 'j', status: 'settled' }) : { jobId: 'j', status: 'settled' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  } });
  const record = { lpAsset: s.P0.lpAsset, shares: String(s.randomShares), receiptLeaf: s.randomReceipt, owner: s.randomOwner, nonce: s.randomNonce, ownerPriv: s.randomPriv };
  await assert.rejects(ux.importFarmPosition({ ...record, nonce: '0x' + '01'.repeat(32) }, { events: s.events }), /do not reproduce the receipt leaf/);
  await assert.rejects(ux.importFarmPosition({ ...record, ownerPriv: '0x' + '02'.repeat(32) }, { events: s.events }), /not the private key/);
  await assert.rejects(ux.importFarmPosition(record, { events: s.events.filter((e) => e.type !== 'LeavesInserted' || e.firstLeafIndex !== 2) }), /not in the pool tree/);
  await assert.rejects(ux.importFarmPosition({ ...record, lpAsset: '0x' + '99'.repeat(32) }, { events: s.events }), /no pool for this LP asset/);
  assert.equal((await ux.farmPositions({ walletPriv, events: s.events })).filter((p) => p.imported).length, 0, 'nothing is listed before the import');
  const r = await ux.importFarmPosition(record, { events: s.events, walletPriv });
  assert.equal(r.imported, true); assert.equal(r.receiptLeaf, s.randomReceipt);
  const listed = await ux.farmPositions({ walletPriv, events: s.events });
  const imp = listed.find((p) => p.imported);
  assert.ok(imp && imp.receiptLeaf === s.randomReceipt && imp.anchorLeaf === null);
  assert.ok(!JSON.stringify(listed).toLowerCase().includes(s.randomPriv.slice(2)), 'the stored key is not returned');
  // The stored record supplies the receipt key: the harvest is signed for the record's owner and nonce.
  await ux.farmHarvest({ walletPriv, position: imp, waitOpts: { intervalMs: 0, sleep: async () => {} } });
  const sub = submitted.at(-1);
  assert.equal(sub.type, 'farmharvest'); assert.equal(sub.op.owner, s.randomOwner); assert.equal(sub.op.nonce, s.randomNonce);
  // A position object naming a receipt with no stored record and no anchor is refused.
  await assert.rejects(ux.farmHarvest({ walletPriv, position: { ...imp, receiptLeaf: s.foreignReceipt }, waitOpts: { intervalMs: 0, sleep: async () => {} } }), /does not belong to this wallet|position from farmPositions is required/);
  // A position the manager no longer holds is not importable.
  const gone = farmScene();
  const goneUx = mkUx(async (m, p) => (m === 'eth_call' && String(p[0].data).startsWith('0x514ea4bf') ? '0x' + [0n, 0n, 0n, 0n, 0n].map(w).join('') : gone.handler(m, p)));
  await assert.rejects(goneUx.importFarmPosition({ lpAsset: gone.P0.lpAsset, shares: String(gone.randomShares), receiptLeaf: gone.randomReceipt, owner: gone.randomOwner, nonce: gone.randomNonce, ownerPriv: gone.randomPriv }, { events: gone.events }), /not hold this position live/);
});

// ── CDP positions ──
test('recoverCdpPositions: a position opened under the derived key nonce is found from the settle calldata; the open flag is read from the pool', async () => {
  const ux0 = mkUx();
  const engine = CFG.collateralEngine;
  const cdp = ux0.cdp;
  const debtAsset = cdp.debtAssetId(engine);
  const cbtc = ux0.pool.CBTC_ZK_ASSET_ID;
  const RATE = '0x' + w(10n ** 27n);
  const mk = (keyNonce, debt, collat) => {
    const ownerPriv = derivePositionOwnerPriv({ hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n }, walletPriv, engine, keyNonce);
    const owner = '0x' + Buffer.from(secp.getPublicKey(ownerPriv.slice(2), true).subarray(1)).toString('hex');
    const legs = [{ asset: cbtc, value: collat }];
    const positionLeaf = cdp.positionLeaf(engine, debtAsset, cdp.basketRoot(legs.map((l) => cdp.basketLeg(l.asset, BigInt(l.value)))), BigInt(debt), RATE, owner, ZERO32);
    return { controller: engine, debtAsset, debtValue: debt, positionLeaf, rateSnapshot: RATE, legs, owner, keyNonce };
  };
  const a = mk(0, 50000000n, 2000n), b = mk(2, 200000n, 252n); // key nonce 1 never used: the walk continues past the gap
  const foreign = { ...mk(0, 1n, 1n), owner: '0x' + '44'.repeat(32) };
  foreign.positionLeaf = cdp.positionLeaf(engine, debtAsset, cdp.basketRoot(foreign.legs.map((l) => cdp.basketLeg(l.asset, BigInt(l.value)))), 1n, RATE, foreign.owner, ZERO32);
  const forged = { ...mk(3, 9n, 9n), positionLeaf: '0x' + '77'.repeat(32) }; // right owner, leaf that does not follow from its fields
  const T = [tx(31), tx(32), tx(33), tx(34)];
  const inputs = new Map([[T[0], a], [T[1], b], [T[2], foreign], [T[3], forged]].map(([t, m]) => [t, settleInput(pvBytes({ 22: mintsTail([m]) }))]));
  const events = [a, b, foreign, forged].map((m, i) => ({ type: 'CdpPositionInserted', leaf: m.positionLeaf, txHash: T[i] }));
  const closedNu = cdp.positionNullifier(b.positionLeaf).toLowerCase();
  const slotKey = (nu) => '0x' + Buffer.from(keccak_256(Buffer.concat([Buffer.from(nu.slice(2), 'hex'), Buffer.from(w(163), 'hex')]))).toString('hex');
  const ux = mkUx(async (method, params) => {
    if (method === 'eth_getTransactionByHash') return { input: inputs.get(params[0]), to: CFG.pool };
    if (method === 'eth_getStorageAt') return params[1] === slotKey(closedNu) ? '0x' + w(1) : '0x' + w(0);
    return undefined;
  });
  const r = await ux.recoverCdpPositions({ walletPriv, events });
  assert.equal(r.positionEvents, 4);
  assert.equal(r.positions.length, 1, 'the closed position and the forged / foreign ones are not listed');
  const p = r.positions[0];
  assert.equal(p.keyNonce, 0); assert.equal(p.positionLeaf, a.positionLeaf); assert.equal(p.debtValue, '50000000'); assert.equal(p.positionIndex, 0);
  assert.deepEqual(p.basket, [{ asset: cbtc, value: '2000' }]); assert.equal(p.live, true);
  assert.equal(p.positionOwner, a.owner);
  const ownerPriv = derivePositionOwnerPriv({ hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n }, walletPriv, engine, 0);
  assert.equal(p.positionOwnerPriv, ownerPriv, 'the descriptor carries the key the close is signed with');
  assert.equal((await ux.recoverCdpPositions({ walletPriv: otherPriv, events })).positions.length, 0);

  // A position lives in its own settle's calldata: one transaction the RPC will not serve is one position the
  // wallet stops knowing about, so it is reported rather than quietly missing from the list.
  const partial = mkUx(async (method, params) => {
    if (method === 'eth_getTransactionByHash') return params[0] === T[0] ? null : { input: inputs.get(params[0]), to: CFG.pool };
    if (method === 'eth_getStorageAt') return '0x' + w(0);
    return undefined;
  });
  const missed = await partial.recoverCdpPositions({ walletPriv, events });
  assert.deepEqual(missed.skipped, [{ txHash: T[0], reason: 'settle calldata unavailable' }]);
  assert.deepEqual(missed.positions.map((x) => x.positionLeaf), [b.positionLeaf], 'the position that was read is still listed');
});

// ── stealth locks the wallet sent ──
test('openSentLocks: the sender tail on a lock memo opens with the sender key, authenticates against the lock leaf and carries the refund key', () => {
  const ux = mkUx();
  const R = makeConfidentialRecovery({ pool: ux.pool, memo: ux.memo, keccak256: keccak_256, secp, hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n, lockScan: ux.lockScan, airdrop: ux.airdrop, cdp: ux.cdp, bpp: { H: bppGens().H, G: BPP_G } });
  const id = ux.identity(walletPriv);
  const recipient = ux.identity(otherPriv);
  const asset = ux.assetByTicker.cETH.assetId;
  const ephemeralPriv = 0x1234567n, refundPriv = 0x7654321n, amount = 30000n, deadline = 1900000000n;
  const lBlinding = '0x' + (0x9999n).toString(16).padStart(64, '0');
  const refundPub = ux.airdrop.refundPubOf(refundPriv);
  const { ownerPub } = ux.stealth.oneTimeAddress({ recipientSpendPub: recipient.pubHex, ephemeralPriv });
  const { cx, cy } = ux.pool.commitXY(amount, lBlinding);
  const lockLeaf = ux.stealth.stealthLockLeafBlind(asset, cx, cy, ownerPub, deadline, refundPub);
  const recipientMemo = ux.airdrop.sealStealthMemo({ recipientSpendPub: recipient.pubHex, ephemeralPriv, asset, amount, lBlinding, deadline, refundPub });
  const ephemeralPub = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(ephemeralPriv).toRawBytes(true)).toString('hex');
  const senderPriv = hexOf(id.priv);
  const tail = ux.airdrop.sealStealthSenderTail({ senderPriv, ephemeralPub, asset, amount, lBlinding, deadline, refundPriv: '0x' + refundPriv.toString(16).padStart(64, '0'), ownerPub, recipientPub: recipient.pubHex });
  const full = recipientMemo + tail.replace(/^0x/, '');
  const lockLeaves = ['0x' + 'ee'.repeat(32), lockLeaf, lockLeaf];
  const sent = R.openSentLocks({ senderPriv, lockLeaves, lockMemos: [full, full, recipientMemo] });
  assert.equal(sent.length, 1, 'a lock memo without the tail is not listed; a memo under another leaf does not authenticate');
  assert.equal(sent[0].lIndex, 1); assert.equal(sent[0].amount, amount); assert.equal(BigInt(sent[0].refundPriv), refundPriv);
  assert.equal(sent[0].recipientPub, recipient.pubHex); assert.equal(sent[0].deadline, deadline);
  assert.equal(R.openSentLocks({ senderPriv: hexOf(ux.identity(otherPriv).priv), lockLeaves, lockMemos: [full, full, recipientMemo] }).length, 0, 'only the sender opens the tail');
  // The recipient can still claim: the sender tail rides after the recipient memo and does not disturb it.
  assert.ok(ux.airdrop.openStealthMemo({ recipientSpendPriv: hexOf(recipient.priv), leaf: lockLeaf, memoHex: full }));
});

// ── the memo integrity check at submit ──
test('recovery guard: a memo sealed to the wallet key must open to its leaf, owner and value before a relayed op is queued', async () => {
  const ux = mkUx();
  const asset = ux.assetByTicker.cETH.assetId;
  const id = ux.identity(walletPriv);
  const n = derivedNote(ux, walletPriv, asset, 4, 1234);
  const out = { value: '1234', blinding: n.blinding, secret: n.secret, asset, owner: n.owner, cx: n.cx, cy: n.cy, ownerPub: id.pubHex };
  const submit = (output, leaf) => ux.relay.submitOp({ type: 'transfer', op: {}, leaves: [leaf], outputs: [output], ephRand: () => 77n });
  // A descriptor whose blinding does not produce the leaf seals a memo that cannot be opened to that leaf.
  await assert.rejects(submit({ ...out, blinding: '0x' + w(999) }, n.leaf), /does not open to its leaf/);
  // A descriptor whose value differs from the leaf's is caught the same way.
  await assert.rejects(submit({ ...out, value: '1235' }, n.leaf), /does not open to its leaf/);
  // A seed-derived output is not opened; an output sealed to someone else's key is checked for shape only.
  const foreign = ux.identity(otherPriv);
  const g = ux.relay; assert.ok(g);
  const foreignOut = { ...out, ownerPub: foreign.pubHex };
  await assert.rejects(submit(foreignOut, n.leaf), (e) => !/does not open/.test(e.message), 'a foreign-key memo is not opened here (the relay call itself fails offline instead)');
});

// ── recover(): the integrator entry point ──
test('recover: one call returns notes, positions, locks, cBTC and diagnostics with a coverage summary; nothing is sent', async () => {
  const s = farmScene();
  const ceth = s.ux0.assetByTicker.cETH;
  const wr = s.ux0.buildWrap({ walletPriv, amountWei: (7000n * BigInt(ceth.unitScale)).toString(), ticker: 'cETH', index: 1 });
  const events = [...s.events, { type: 'Wrap', depositId: wr.depositId, assetId: ceth.assetId, amount: 7000n * BigInt(ceth.unitScale), txHash: tx(40) }, leavesEv(4, [wr.leaf], null, tx(41))];
  const sent = [];
  const ux = mkUx(async (method, params) => {
    sent.push(method);
    if (method === 'eth_blockNumber') return '0x' + (CFG.deployBlock + 10).toString(16);
    if (method === 'eth_getStorageAt') return '0x' + w(0);
    return s.handler(method, params);
  });
  const r = await ux.recover({ walletPriv, events, cbtc: false, cdp: false, locks: false, deep: false });
  assert.deepEqual(Object.keys(r).sort(), ['cbtc', 'cdpPositions', 'diagnostics', 'farmPositions', 'notes', 'receivedLocks', 'sentLocks']);
  assert.equal(r.notes.length, 1); assert.equal(r.notes[0].source, 'wrap'); assert.equal(BigInt(r.notes[0].value), 7000n);
  assert.equal(r.farmPositions.length, 1);
  const d = r.diagnostics;
  assert.equal(d.farm.bondedEvents, 3); assert.equal(d.farm.derivedFromEvents, 1); assert.equal(d.farm.bondedNotDerived, 2);
  assert.equal(d.notes.viaWrapWalk, 1); assert.equal(d.notes.unspent, 1);
  assert.equal(d.coverage.complete, true);
  assert.ok(d.coverage.farmPositions.needsImportedRecord && d.coverage.cdpPositions.needsSavedRecord);
  assert.ok(!sent.some((m) => /send|Raw/i.test(m)), 'read-only: no transaction is sent');
  // A failing category is reported without hiding the rest.
  const bad = mkUx(async (method, params) => { if (method === 'eth_call') throw new Error('node refused'); return method === 'eth_blockNumber' ? '0x1' : undefined; });
  const partial = await bad.recover({ walletPriv, events, cbtc: false, cdp: false, locks: false, deep: false });
  assert.equal(partial.notes.length, 1); assert.equal(partial.diagnostics.coverage.complete, false); assert.ok(partial.diagnostics.errors.farm);
});

test('balance keeps its shape and still recovers ordinary memo notes alongside the derived kinds', async () => {
  const ux0 = mkUx();
  const ceth = ux0.assetByTicker.cETH;
  const n = derivedNote(ux0, walletPriv, ceth.assetId, 9, 555);
  const events = [leavesEv(0, [n.leaf], [sealTo(ux0, walletPriv, n)], tx(50))];
  const b = await mkUx(chainHandler(events)).balance(walletPriv);
  // `diag` is part of the contract: several channels (cBTC, bridge-mint) have no memo at all, so key+chain
  // re-derivation is the only way to find those notes — and _scanNotes swallows a per-channel failure so one
  // dead endpoint cannot blank the whole wallet. Without diag travelling with the result, a caller cannot
  // tell an empty channel from one that errored, and an esplora outage reads as a zero balance.
  assert.deepEqual(Object.keys(b).sort(), ['byAsset', 'diag', 'notes', 'poolStats']);
  assert.deepEqual(b.diag.errors, {}, 'a clean scan reports no channel errors');
  assert.equal(b.notes.length, 1); assert.equal(BigInt(b.notes[0].value), 555n);
  assert.equal(b.notes[0].source, undefined);
});
