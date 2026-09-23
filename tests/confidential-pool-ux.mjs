import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';

// secp.sign (RFC 6979) needs the sync HMAC set — the dapp's vendor bundle does this; do it for the test too.
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
// Derive the live signet config so these tests track the deploy sync instead of going stale on every
// re-pin (the DeployV1Suite manifest → confidential-deployments.generated.js overwrites pool/deployBlock).
const SIGNET = getConfidentialDeployment('signet');
const POOL = SIGNET.pool;
const DEPLOY_BLOCK = SIGNET.deployBlock;
// cETH unit math, derived from config so the tests track the live scale (1e10) instead of hardcoding it.
// A wrap of `amountWei` produces an in-system note value of amountWei / CETH_SCALE; the relay floor is the
// wei floor (1e14) ÷ scale.
const CETH_SCALE = BigInt(SIGNET.assets.find((a) => a.ticker === 'cETH').unitScale);
const inSys = (amountWei) => BigInt(amountWei) / CETH_SCALE;
const CETH_FLOOR = 100000000000000n / CETH_SCALE;

test('config: Sepolia pilot pool + cETH', () => {
  const c = getConfidentialDeployment('signet');
  assert.match(c.pool, /^0x[0-9a-fA-F]{40}$/, 'pool address pinned');
  assert.equal(c.chainId, 11155111);
  assert.ok(Number.isInteger(c.deployBlock) && c.deployBlock > 0, 'deployBlock pinned');
  const ceth = c.assets.find((a) => a.ticker === 'cETH');
  assert.ok(ceth, 'cETH registered');
  assert.equal(ceth.assetId, '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2');
  assert.equal(ceth.underlying, '0x0000000000000000000000000000000000000000');
});

test('account: deterministic, domain-separated Sepolia EVM derivation', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const priv = '0x' + '11'.repeat(32);
  const a1 = ux.account(priv);
  const a2 = ux.account(priv);
  assert.match(a1.address, /^0x[0-9a-f]{40}$/);
  assert.equal(a1.address, a2.address, 'deterministic');
  assert.notEqual(a1.priv.toLowerCase(), priv.toLowerCase(), 'EVM key is domain-separated, not the wallet key');
});

test('fetchEvents: pool-scoped LeavesInserted/NullifiersSpent/LockLeavesInserted filter from the deploy block', async () => {
  const ev0 = makeConfidentialEvmLog({ keccak256: keccak_256 });
  // fetchEvents resolves toBlock='latest' via eth_blockNumber before eth_getLogs; a mock that returns the
  // same `{ result: [] }` for both makes parseInt(await rpc('eth_blockNumber'), 16) = NaN, so the log-window
  // loop's `start <= to` is never true and eth_getLogs is never called — `captured` then holds the
  // eth_blockNumber call instead of a log-window request.
  let captured = null;
  const ux = makeConfidentialPoolUx({
    ...deps,
    fetchImpl: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_blockNumber') return { ok: true, json: async () => ({ result: '0x' + Number(DEPLOY_BLOCK).toString(16) }) };
      captured = body;
      return { ok: true, json: async () => ({ result: [] }) };
    },
  });
  const evs = await ux.fetchEvents();
  assert.deepEqual(evs, []);
  assert.equal(captured.method, 'eth_getLogs');
  assert.equal(captured.params[0].address, POOL);
  assert.equal(captured.params[0].fromBlock, '0x' + (DEPLOY_BLOCK).toString(16));
  assert.deepEqual(captured.params[0].topics[0], [ev0.TOPIC0.LeavesInserted, ev0.TOPIC0.NullifiersSpent, ev0.TOPIC0.LockLeavesInserted], 'topic0 OR-filter = [LeavesInserted, NullifiersSpent, LockLeavesInserted]');
});

test('balance: empty pool -> zero, no off-chain storage', async () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
  const b = await ux.balance('0x' + '22'.repeat(32));
  assert.deepEqual(b.notes, []);
  assert.deepEqual(b.byAsset, {});
  assert.deepEqual(b.poolStats, { totalNotesCreated: 0, totalNullifiersSpent: 0, outstandingNotes: 0 }, 'an empty event stream is a real zero, not undefined');
});

// poolStatsFromEvents backs the Send tab's "shielded notes currently in the pool" line — derived from the
// SAME event stream balance() already fetches (no extra RPC round trip). Unit-tested directly on
// already-decoded event shapes (confidential-evm-log.js's own decoder is tested elsewhere), covering:
// several settles' firstLeafIndex advancing the running total, an out-of-order stream (max, not sum, of
// firstLeafIndex+leaves.length), and spends never pushing the outstanding count negative.
test('poolStatsFromEvents: derives created/spent/outstanding from a LeavesInserted+NullifiersSpent stream', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  assert.deepEqual(ux.poolStatsFromEvents([]), { totalNotesCreated: 0, totalNullifiersSpent: 0, outstandingNotes: 0 });

  const events = [
    { type: 'LeavesInserted', firstLeafIndex: 0, leaves: ['0x1', '0x2'] },   // running total → 2
    { type: 'NullifiersSpent', nullifiers: ['0xa'] },                        // spent → 1
    { type: 'LeavesInserted', firstLeafIndex: 2, leaves: ['0x3', '0x4', '0x5'] }, // running total → 5
    { type: 'NullifiersSpent', nullifiers: [] },                             // an ordinary transfer's own change leg, zero nullifiers, must not crash
  ];
  assert.deepEqual(ux.poolStatsFromEvents(events), { totalNotesCreated: 5, totalNullifiersSpent: 1, outstandingNotes: 4 });

  // Out-of-chain-order stream (a caller merging pages) — total is the MAX end index seen, not the count of
  // events, since a re-org/duplicate fetch could otherwise double count.
  const outOfOrder = [
    { type: 'LeavesInserted', firstLeafIndex: 2, leaves: ['0x3', '0x4', '0x5'] }, // end = 5
    { type: 'LeavesInserted', firstLeafIndex: 0, leaves: ['0x1', '0x2'] },        // end = 2, must not override the higher total
  ];
  assert.equal(ux.poolStatsFromEvents(outOfOrder).totalNotesCreated, 5);

  // More nullifiers than leaves (can't happen on a real chain — the contract's ReserveFloorBreach forbids
  // it — but a defensive stat must never go negative from a malformed/partial event window).
  const overspent = [
    { type: 'LeavesInserted', firstLeafIndex: 0, leaves: ['0x1'] },
    { type: 'NullifiersSpent', nullifiers: ['0xa', '0xb'] },
  ];
  assert.equal(ux.poolStatsFromEvents(overspent).outstandingNotes, 0, 'never negative');
});

test('rpc: falls over to the next endpoint on failure', async () => {
  let calls = 0;
  const ux = makeConfidentialPoolUx({
    ...deps,
    fetchImpl: async (url) => { calls++; if (calls === 1) throw new Error('down'); return { ok: true, json: async () => ({ result: '0x1' }) }; },
  });
  const r = await ux.rpc('eth_blockNumber', []);
  assert.equal(r, '0x1');
  assert.equal(calls, 2, 'used the fallback after the first RPC threw');
});

test('tickerOf: resolves cETH, null for unknown', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  assert.equal(ux.tickerOf('0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2'), 'cETH');
  assert.equal(ux.tickerOf('0xdead'), null);
});

test('buildWrap: coherent note + pool.wrap calldata', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '33'.repeat(32);
  const amountWei = '1000000000000000'; // 0.001 ETH; in-system value = amountWei / cETH scale
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  // the commitment re-derives from the opening
  const { cx, cy } = ux.pool.commitXY(BigInt(w.note.value), w.note.blinding);
  assert.equal(cx, w.note.cx);
  assert.equal(cy, w.note.cy);
  assert.equal(BigInt(w.note.value), inSys(amountWei));
  assert.equal(w.leaf, ux.pool.leaf(w.note.asset, cx, cy, w.note.owner));
  assert.equal(w.to, POOL);
  assert.equal(w.amount, amountWei);
  // calldata = 4-byte selector + 3 × 32-byte words (assetId, amount, commit) — the raw coords + owner
  // are NOT in calldata; only commit = keccak(Cx‖Cy‖owner) is, so the note's ν stays uncomputable.
  assert.equal(w.calldata.length, 2 + 2 * (4 + 3 * 32));
  assert.equal(w.commit, ux.pool.depositCommit(cx, cy, w.note.owner));
  const cd = w.calldata.toLowerCase();
  for (const secret of [cx, cy, w.note.owner]) {
    assert.ok(!cd.includes(secret.toLowerCase().replace(/^0x/, '')), 'raw commitment coord/owner must not appear in wrap calldata');
  }
  // the depositId still binds value over the digest (the on-chain no-inflation gate)
  assert.equal(w.depositId, ux.pool.depositId(w.note.asset, BigInt(w.note.value), cx, cy, w.note.owner));
  // rejects misaligned / non-positive amounts
  assert.throws(() => ux.buildWrap({ walletPriv, amountWei: '0', ticker: 'cETH' }));
});

test('buildWrap + recovery round-trip: the wrapped note recovers seed-only from its leaf+memo', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '33'.repeat(32);
  const amountWei = '1000000000000000';
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  // synthesize the LeavesInserted event the box emits at OP_WRAP settle, then scan with the wallet key
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const notes = ux.indexer.recover(events, walletPriv);
  assert.equal(notes.length, 1, 'wrapped note recovered from chain + seed alone');
  assert.equal(BigInt(notes[0].value), inSys(amountWei));
  assert.equal(notes[0].cx.toLowerCase(), w.note.cx.toLowerCase());
});

test('buildWrap: the output passes the recovery guard, and a stripped memo is caught before submit', async () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const { makeRecoveryGuard } = await import('../dapp/confidential-recovery-guard.js');
  const guard = makeRecoveryGuard({ memo: ux.indexer._memo });
  const w = ux.buildWrap({ walletPriv: '0x' + '33'.repeat(32), amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  // buildWrap routes its seal through the guard and exposes the aligned outputs/memos it validated.
  assert.equal(w.outputs.length, 1, 'one output descriptor');
  assert.equal(w.memos.length, 1, 'one aligned memo');
  assert.equal(w.memos[0], w.memo, 'singular memo == memos[0] (back-compat)');
  guard.assertOutputsRecoverable({ leaves: [w.leaf], outputs: w.outputs, memos: w.memos });
  // a memo-sealed (non-seed-derived) output with its memo stripped is an unrecoverable leaf — the
  // submit-time tripwire rejects it BEFORE it can reach the chain (= permanent fund loss).
  assert.throws(
    () => guard.assertOutputsRecoverable({ leaves: [w.leaf], outputs: w.outputs, memos: ['0x'] }),
    /unrecoverable|recovery channel/,
    'a wrap output with its memo stripped is rejected at submit'
  );
});

test('buildUnwrap: gasless exit splits value into net + relay fee, op matches the box harness', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '44'.repeat(32);
  const amountWei = '1000000000000000'; // 0.001 ETH
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];

  // fee = max(floor, ceil(0.3%)); the per-asset wei floor (1e14 wei ÷ unitScale) dominates a small exit
  const q = ux.quoteUnwrapFee(note.value, 'cETH');
  assert.equal(q.fee, CETH_FLOOR, 'floor fee dominates small exit');
  assert.equal(q.net, inSys(amountWei) - CETH_FLOOR, 'user receives value − fee');
  assert.equal(q.fee + q.net, BigInt(note.value), 'fee + net == proven value (conserved)');

  const built = ux.buildUnwrap({ note, walletPriv });
  assert.equal(built.fee, q.fee);
  assert.equal(built.net, q.net);
  // op shape == the fields exec-unwrap.rs reads (same stdin order as the guest)
  assert.equal(built.op.spendRoot, note.root);
  assert.equal(built.op.asset, note.asset);
  assert.equal(built.op.value, String(note.value));
  assert.equal(built.op.fee, q.fee.toString());
  assert.equal(built.op.leafIndex, 0);
  assert.ok(Array.isArray(built.op.path) && built.op.path.length > 0, 'membership path present');
  assert.equal(built.op.recipient, ux.account(walletPriv).address.toLowerCase(), 'defaults to the user EVM account');
  // chainBinding == keccak(abi.encodePacked(chainid, pool)) — what the contract stamps + the guest commits
  const cid = (11155111n).toString(16).padStart(64, '0');
  const addr = POOL.replace(/^0x/, '').toLowerCase();
  const expect = '0x' + Buffer.from(keccak_256(Uint8Array.from((cid + addr).match(/../g).map((h) => parseInt(h, 16))))).toString('hex');
  assert.equal(built.op.chainBinding, expect, 'chainBinding = keccak(chainid‖pool)');
});

test('buildUnwrap selfSettle: no-fee exit preserved — full value to recipient, fee 0', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '55'.repeat(32);
  const w = ux.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];

  const self = ux.buildUnwrap({ note, walletPriv, selfSettle: true });
  assert.equal(self.fee, 0n, 'self-settle pays no fee');
  assert.equal(self.net, BigInt(note.value), 'full value exits to the recipient');
  assert.equal(self.op.fee, '0', 'witness carries fee = 0 (guest: net = value, no FeePayment)');

  // a dust note that can't be relayed gaslessly CAN still self-settle (fee 0). Use a REAL note (proper
  // blinding + commitment) so the opening sigma is well-formed — a real note never has a zero blinding.
  const z = '0x' + '00'.repeat(32);
  const asset0 = getConfidentialDeployment('signet').assets[0].assetId;
  const idd = ux.identity(walletPriv);
  const dn = ux.pool.deriveNote(idd.priv, asset0, 7);
  const dnBlind = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
  const dc = ux.pool.commitXY(50000000000000n, dnBlind);
  const dust = { asset: asset0, value: '50000000000000', root: z, cx: dc.cx, cy: dc.cy, owner: idd.owner, leafIndex: 0, path: [z], secret: dn.secret, blinding: dnBlind };
  const dustSelf = ux.buildUnwrap({ note: dust, walletPriv, selfSettle: true });
  assert.equal(dustSelf.fee, 0n);
  assert.equal(dustSelf.net, 50000000000000n, 'dust note exits in full when self-settled');
});

// A note + recipient pubkey suitable for driving ux.transfer with a mocked relay/RPC. Builds a REAL
// single-leaf Merkle tree so buildTransferOp's local membership self-check (input i must reconstruct
// spendRoot from leafIndex/path) passes — an arbitrary placeholder root/path throws "note witness is
// stale" for every caller of this fixture.
function transferFixture(ux, walletPriv) {
  const w = ux.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];
  const tree = new ux.pool.Tree();
  const leafIndex = tree.insert(w.leaf);
  note.root = tree.root();
  note.path = tree.rootAndPath(leafIndex).path;
  note.leafIndex = leafIndex;
  // SELF-send: a native note's owner is keccak(nk ‖ dom), so only the holder of nk can mint a spendable
  // owner. These cases exercise relay DISPATCH (prove-vs-settle, who broadcasts), for which a self-send
  // is the valid vehicle; third-party payment is the stealth lock/claim path and is asserted separately.
  const recipientPubHex = ux.identity(walletPriv).pubHex;
  return { note, recipientPubHex };
}

// Routes relay submit / status / RPC through one fetch mock; records which legs fired.
function relayRpcMock(seen, submitStatus = 'proven') {
  return async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    let obj;
    if (String(url).includes('/confidential/submit')) { seen.submitMode = body && body.mode; obj = { jobId: 'j1', status: submitStatus }; }
    else if (String(url).includes('/confidential/status')) { obj = { jobId: 'j1', status: submitStatus, publicValues: '0xaa', proof: '0xbb' }; }
    else { const m = body && body.method; if (m === 'eth_sendRawTransaction') seen.broadcast = true; obj = { result: m === 'eth_gasPrice' ? '0x3b9aca00' : m === 'eth_sendRawTransaction' ? '0x' + 'cd'.repeat(32) : '0x0' }; }
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
}

test('transfer selfRelay: box proves (mode=prove) then broadcasts settle from the user EOA', async () => {
  const seen = {};
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relayRpcMock(seen, 'proven') });
  const walletPriv = '0x' + '66'.repeat(32);
  const { note, recipientPubHex } = transferFixture(ux, walletPriv);
  const r = await ux.transfer({ walletPriv, notes: [note], recipientPubHex, amount: 40000n, selfRelay: true });
  assert.equal(seen.submitMode, 'prove', 'self-relay submits a PROVE-only job (no settler)');
  assert.equal(seen.broadcast, true, 'self-relay broadcasts settle() from the user EOA');
  assert.equal(r.from, ux.account(walletPriv).address, 'settle sent from the user EVM account');
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
});

test('transfer self-send: every output is spendable with the nk sealed into its own memo', () => {
  // Same class of check as buildWrapTransferOp's spendability assertion: the recipient output's owner is
  // H(recvNk) (fresh per send), and its memo must carry recvNk — not id.secret, the wallet-constant nk the
  // CHANGE output correctly uses. The leaf-hash authenticator never checks `secret`, so a mismatch here
  // decrypts fine and looks recovered, then is permanently unspendable only once someone tries to spend it.
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '44'.repeat(32);
  const { note, recipientPubHex } = transferFixture(ux, walletPriv);
  const built = ux.buildTransferOp({ walletPriv, notes: [note], recipientPubHex, amount: 40000n });
  assert.equal(built.outputs.length, 2, 'recipient + change (note value exceeds the sent amount)');
  for (const o of built.outputs) {
    assert.equal(ux.pool.nkToOwner(o.secret).toLowerCase(), String(o.owner).toLowerCase(),
      `output owned by ${o.owner} must be spendable with the nk sealed into its own memo`);
  }
});

test('transfer refuses a third-party recipient (it would mint an unspendable note)', () => {
  // A native note's owner is keccak(nk ‖ dom) — a hash, not a curve point — so a sender cannot derive an
  // owner without knowing nk, and nk is spend authority. Publishing the recipient's pubkey as owner mints a
  // note no nk hashes to: unspendable forever, on an immutable vkey. The client must fail closed and send
  // callers to stealth lock/claim, where the RECIPIENT chooses the owner.
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '33'.repeat(32);
  const { note } = transferFixture(ux, walletPriv);
  const stranger = ux.identity('0x' + '77'.repeat(32)).pubHex;
  assert.throws(
    () => ux.buildTransferOp({ walletPriv, notes: [note], recipientPubHex: stranger, amount: 40000n }),
    /third party|stealth/i,
  );
});

test('transfer default: relays the settle (no prove, no user broadcast)', async () => {
  const seen = {};
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relayRpcMock(seen, 'settled') });
  const walletPriv = '0x' + '66'.repeat(32);
  const { note, recipientPubHex } = transferFixture(ux, walletPriv);
  await ux.transfer({ walletPriv, notes: [note], recipientPubHex, amount: 40000n });
  assert.equal(seen.submitMode, undefined, 'default path submits a settle job (no prove mode)');
  assert.notEqual(seen.broadcast, true, 'default path never broadcasts from the user EOA');
});

test('quoteUnwrapFee: percent dominates a large exit; a dust note is rejected for gasless exit', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  // 1 ETH: 0.3% = 3e15 > floor 1e14 → percent applies
  const big = ux.quoteUnwrapFee(1000000000000000000n, 'cETH');
  assert.equal(big.fee, 3000000000000000n, '0.3% of 1e18');
  assert.equal(big.net, 997000000000000000n);
  // a note at/under the floor can't be relayed (the fee would eat it) → buildUnwrap throws
  const z = '0x' + '00'.repeat(32);
  const dust = { asset: getConfidentialDeployment("signet").assets[0].assetId, value: "5000", root: z, cx: z, cy: z, owner: z, leafIndex: 0, path: [z], secret: z, blinding: z };
  assert.throws(() => ux.buildUnwrap({ note: dust, walletPriv: '0x' + '44'.repeat(32) }), /too small/);
});

test('wrap: signs an EIP-1559 deposit tx (no broadcast)', async () => {
  const ux = makeConfidentialPoolUx({
    ...deps,
    fetchImpl: async (_url, opts) => {
      const m = JSON.parse(opts.body).method;
      const result = m === 'eth_getTransactionCount' ? '0x0' : m === 'eth_gasPrice' ? '0x3b9aca00' : m === 'eth_blockNumber' ? '0x' + Number(DEPLOY_BLOCK).toString(16) : m === 'eth_getLogs' ? [] : '0x';
      return { ok: true, json: async () => ({ result }) };
    },
  });
  const walletPriv = '0x' + '33'.repeat(32);
  const r = await ux.wrap({ walletPriv, amountWei: '1000000000000000', broadcast: false });
  assert.match(r.signedRaw, /^0x02/, 'EIP-1559 typed-tx envelope');
  assert.equal(r.txHash, null);
  assert.equal(r.from, ux.account(walletPriv).address);
});

// A chain that serves the pool's Wrap logs (filtered by the requested topics) and the reads a wrap needs.
const evmLogForWrap = makeConfidentialEvmLog({ keccak256: keccak_256 });
const wrapWord = (v) => BigInt(v).toString(16).padStart(64, '0');
function wrapChain({ deposits = [], failLogs = false } = {}) {
  const logs = deposits.map((d, i) => ({
    address: POOL, blockNumber: '0x' + (Number(DEPLOY_BLOCK) + 1 + i).toString(16), logIndex: '0x0', transactionHash: '0x' + String(i + 1).padStart(64, '0'),
    topics: [evmLogForWrap.TOPIC0.Wrap, d.depositId, d.assetId], data: '0x' + wrapWord(d.amount),
  }));
  const seen = { getLogs: [] };
  const fetchImpl = async (_url, opts) => {
    const { method, params } = JSON.parse(opts.body);
    if (method === 'eth_getLogs') {
      seen.getLogs.push(params[0]);
      if (failLogs) return { ok: false, status: 500, json: async () => ({}) };
      const t = params[0].topics;
      const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
      const hit = logs.filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to
        && (t[0] == null || t[0] === l.topics[0]) && (t[2] == null || t[2] === l.topics[2]));
      return { ok: true, json: async () => ({ result: hit }) };
    }
    const result = method === 'eth_blockNumber' ? '0x' + (Number(DEPLOY_BLOCK) + 20).toString(16)
      : method === 'eth_getTransactionCount' ? '0x0' : method === 'eth_gasPrice' ? '0x3b9aca00' : '0x0';
    return { ok: true, json: async () => ({ result }) };
  };
  return { fetchImpl, seen };
}

test('wrap: takes the next unused derivation index, and honors an explicit one', async () => {
  const walletPriv = '0x' + '34'.repeat(32);
  const probe = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const assetId = probe.assetByTicker.cETH.assetId;
  const first = probe.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  const second = probe.buildWrap({ walletPriv, amountWei: '3000000000000000', ticker: 'cETH', index: 1 });
  assert.equal(first.index, 0);
  assert.notEqual(first.note.secret, second.note.secret, 'each index derives its own note secret');
  assert.notEqual(first.note.blinding, second.note.blinding, 'and its own blinding');

  // No deposits yet: index 0. Another wallet's deposit at index 0 does not use this wallet's index.
  const other = probe.buildWrap({ walletPriv: '0x' + '35'.repeat(32), amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  let chain = wrapChain({ deposits: [{ depositId: other.depositId, assetId, amount: 10n ** 15n }] });
  let ux = makeConfidentialPoolUx({ ...deps, fetchImpl: chain.fetchImpl });
  assert.equal((await ux.wrap({ walletPriv, amountWei: '1000000000000000', broadcast: false })).index, 0);

  // Index 0 already holds a deposit (of another amount): the next wrap moves to 1, and 1 is used once it lands.
  chain = wrapChain({ deposits: [{ depositId: first.depositId, assetId, amount: 10n ** 15n }] });
  ux = makeConfidentialPoolUx({ ...deps, fetchImpl: chain.fetchImpl });
  const w = await ux.wrap({ walletPriv, amountWei: '3000000000000000', broadcast: false });
  assert.equal(w.index, 1);
  assert.equal(w.depositId, second.depositId, 'the deposit is the one index 1 derives');
  assert.ok(chain.seen.getLogs.every((f) => f.topics[2] === assetId), 'only this asset\'s deposits are read');
  chain = wrapChain({ deposits: [{ depositId: first.depositId, assetId, amount: 10n ** 15n }, { depositId: second.depositId, assetId, amount: 3n * 10n ** 15n }] });
  ux = makeConfidentialPoolUx({ ...deps, fetchImpl: chain.fetchImpl });
  assert.equal((await ux.wrap({ walletPriv, amountWei: '5000000000000000', broadcast: false })).index, 2);

  // An explicit index is used as given and reads no deposits.
  chain = wrapChain({ deposits: [{ depositId: first.depositId, assetId, amount: 10n ** 15n }] });
  ux = makeConfidentialPoolUx({ ...deps, fetchImpl: chain.fetchImpl });
  const pinned = await ux.wrap({ walletPriv, amountWei: '1000000000000000', index: 0, broadcast: false });
  assert.equal(pinned.index, 0);
  assert.equal(chain.seen.getLogs.length, 0);
});

test('wrap: wraps sent back to back take different indexes before the first one lands', async () => {
  const walletPriv = '0x' + '36'.repeat(32);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: wrapChain().fetchImpl });
  const a = await ux.wrap({ walletPriv, amountWei: '1000000000000000', broadcast: false });
  const b = await ux.wrap({ walletPriv, amountWei: '1000000000000000', broadcast: false });
  const [c, d] = await Promise.all([
    ux.wrap({ walletPriv, amountWei: '1000000000000000', broadcast: false }),
    ux.wrap({ walletPriv, amountWei: '1000000000000000', broadcast: false }),
  ]);
  assert.deepEqual([a.index, b.index].concat([c.index, d.index].sort()), [0, 1, 2, 3]);
  assert.equal(new Set([a, b, c, d].map((w) => w.depositId)).size, 4, 'four distinct deposit ids');
  assert.equal(new Set([a, b, c, d].map((w) => w.note.secret)).size, 4, 'four distinct note secrets');
});

test('wrap: an unreadable deposit history fails the wrap instead of guessing an index; an explicit index still wraps', async () => {
  // The device hint cannot see indexes another device used, so without the chain scan no index is known safe.
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: wrapChain({ failLogs: true }).fetchImpl });
  await assert.rejects(
    ux.wrap({ walletPriv: '0x' + '37'.repeat(32), amountWei: '1000000000000000', broadcast: false }),
    /could not read this asset's wrap deposits.*pass an explicit index/,
  );
  const r = await ux.wrap({ walletPriv: '0x' + '37'.repeat(32), amountWei: '1000000000000000', broadcast: false, index: 0 });
  assert.equal(r.index, 0);
});

test('buildWrapTransferOp: deposit consumed into hidden recipient + change, conservation self-verifies', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '88'.repeat(32);
  // Self-send: a third-party recipient is refused (see the guard test below), because a pubkey-derived
  // owner would mint a note no nk hashes to and burn the wrapped ETH.
  const recipientPubHex = ux.identity(walletPriv).pubHex;
  const amountWei = '1000000000000000'; // 0.001 ETH; at cETH scale 1e10 the in-system value = amountWei/1e10
  // build() throws on conservation/range/recovery failure, so a returned op IS self-verified.
  const b = ux.buildWrapTransferOp({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex, amount: 60000n });
  // recipient + change outputs sum to the deposit value inSys(amountWei) (fee 0): 60000 + 40000 = 100000
  assert.equal(b.op.outputs.length, 2, 'recipient + change');
  assert.equal(b.amount, 60000n);
  assert.equal(b.change, 40000n);
  assert.equal(b.fee, 0n);
  // deposit binding is identical to a plain buildWrap of the same deposit (same wallet-derived blinding) —
  // so the guest's deposit_id + opening sigma match either entrypoint.
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  assert.equal(b.depositCommit, w.commit, 'deposit commit == buildWrap commit (reproducible deposit)');
  assert.equal(b.depositId, w.depositId, 'deposit id matches buildWrap');
  assert.ok(b.op.deposit.sigR && b.op.deposit.sigZ, 'deposit opening sigma present');
  // The received output is owned by keccak(nk ‖ dom) for a FRESH per-note nk — never the raw pubkey, which
  // is the shape the guest rejects (and which would strand the note forever). Asserting "not the pubkey"
  // is the point.
  const pubkeyOwner = '0x' + recipientPubHex.replace(/^0x/, '').slice(2, 66);
  assert.notEqual(b.op.outputs[0].owner, pubkeyOwner, 'received note must NOT be bound to a raw pubkey');
  assert.match(b.op.outputs[0].owner, /^0x[0-9a-f]{64}$/, 'owner is a 32-byte nk-derived digest');
  assert.notEqual(b.op.outputs[0].owner, b.op.outputs[1].owner, 'received and change notes use distinct nk (unlinkable)');
  // one aligned recovery memo per output (guard tripwire already ran inside build)
  assert.equal(b.memos.length, 2, 'one memo per output');
  assert.equal(b.leaves.length, 2);
  // SPENDABILITY, not just presence: the memo's sealed `secret` must be the nk that actually hashes to the
  // leaf's own `owner` — confidential-memo.js's leaf-hash authenticator checks (asset, cx, cy, owner) only,
  // never `secret`, so a wrong secret here would still decrypt and pass recovery, then be permanently
  // unspendable (nk_to_owner mismatch in the guest) only once someone tried to actually spend it. Sealing
  // the wallet-constant id.secret against this freshly-nk-owned output would be exactly that: recoverable,
  // never spendable.
  for (const o of b.outputs) {
    assert.equal(ux.pool.nkToOwner(o.secret).toLowerCase(), String(o.owner).toLowerCase(),
      `output owned by ${o.owner} must be spendable with the nk sealed into its own memo`);
  }
  // rejects an over-spend (amount + fee > deposit)
  assert.throws(() => ux.buildWrapTransferOp({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex, amount: 2000000000000000n }), /exceeds the deposit/);
});

test('wrap-and-send refuses a third-party recipient instead of burning the deposit', () => {
  // A native note's owner is keccak(nk ‖ dom). Deriving the recipient's owner from their PUBKEY mints a note
  // no nk hashes to — unspendable forever against an immutable vkey, taking the wrapped ETH with it. A
  // sender-chosen nk is no better: whoever picks nk can spend the note. Third-party sends belong on the
  // stealth lock/claim path, so this must fail closed rather than produce a burning op.
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '88'.repeat(32);
  const stranger = ux.identity('0x' + '99'.repeat(32)).pubHex;
  assert.throws(
    () => ux.buildWrapTransferOp({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', recipientPubHex: stranger, amount: 60000n }),
    /third party|stealth/i,
  );
});

test('wrapAndSend (native, fee 0): prove-only then user broadcasts router.wrapAndSettleETH{value}', async () => {
  const seen = {};
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relayRpcMock(seen, 'proven') });
  const walletPriv = '0x' + 'a1'.repeat(32);
  const recipientPubHex = ux.identity(walletPriv).pubHex; // self-send; third-party is refused (guard test below)
  const amountWei = '1000000000000000';
  const r = await ux.wrapAndSend({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex, amount: 60000n });
  assert.equal(r.index, 0, 'first wrap of the wallet and asset');
  assert.equal(seen.submitMode, 'prove', 'wrap-and-send submits a PROVE-only job (proof embedded in the user tx)');
  assert.equal(seen.broadcast, true, 'the user broadcasts the wrap-and-settle tx themselves');
  assert.equal(r.from, ux.account(walletPriv).address, 'sent from the user EVM account');
  assert.equal(r.to, ux.cfg.router, 'targets the ConfidentialRouter');
  assert.equal(r.value, amountWei, 'the ETH deposit rides as msg.value');
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  // the fee-bearing relayed path is a follow-up — the user-sent router gate is fee-free
  await assert.rejects(() => ux.wrapAndSend({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex, amount: 1n, fee: 5n }), /fee-free|fee must be 0/);
});

test('buildLpBondOp: fused add+bond witness — canonical order, derived shares, A/B sigmas self-verify', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + 'c3'.repeat(32);
  const id = ux.identity(walletPriv);
  const controller = '0x' + 'fa'.repeat(20);
  const z = '0x' + '00'.repeat(32);
  // Two real notes of a canonical pair (assetA < assetB), each with a proper blinding so the opening sigma
  // is well-formed. Reserves/shares 10000 each → an in-ratio 1000/1000 add.
  const assetLow = '0x0a' + 'a'.repeat(62);
  const assetHigh = '0x' + 'b0'.repeat(32);
  const mkNote = (asset, val, idx) => {
    const dn = ux.pool.deriveNote(id.priv, asset, idx);
    const blind = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
    const { cx, cy } = ux.pool.commitXY(BigInt(val), blind);
    return { asset, value: String(val), cx, cy, owner: id.owner, blinding: blind, leafIndex: idx, path: [z], root: '0x' + '00'.repeat(31) + '01' };
  };
  const aNote = mkNote(assetLow, 1000, 0);
  const bNote = mkNote(assetHigh, 1000, 1);
  // Pass the notes in REVERSE (high, low) to exercise canonicalization.
  const b = ux.buildLpBondOp({
    walletPriv, controller, aNote: bNote, bNote: aNote, feeBps: 30,
    reserveAPre: 10000n, reserveBPre: 10000n, sharesPre: 10000n,
  });
  assert.equal(b.assetA, assetLow, 'canonicalized: assetA is the lex-smaller id');
  assert.equal(b.assetB, assetHigh);
  assert.equal(b.dShares, ux.pool.lpAddShares(10000n, 1000n, 1000n, 10000n, 10000n), 'shares = lpAddShares(...)');
  assert.equal(b.op.controller, controller, '20-byte controller in the op');
  assert.ok(b.op.a.sigR && b.op.a.sigZ && b.op.b.sigR && b.op.b.sigZ, 'A + B opening sigmas present');
  // both legs re-verify against the SAME bound context the build assembled
  const bondPid = ux.pool.evmPoolId(assetLow, assetHigh, 30), bondLpAsset = ux.pool.evmLpShareId(bondPid);
  const ctx = ux.pool.intentContext('tacit-lp-bond-v1', b.op.chainBinding, assetLow, assetHigh,
    [[aNote.cx, aNote.cy, id.owner], [bNote.cx, bNote.cy, id.owner], ['0x' + '00'.repeat(12) + controller.replace(/^0x/, ''), b.bondNonce, b.receiptOwner], [bondLpAsset, bondPid, b.receiptOwner]],
    [1000n, 1000n, b.dShares, 0n, 0n]); // guest form: [d_a, d_b, d_shares, op_deadline, fee] — no rps words
  assert.ok(ux.pool.verifyOpeningSigma(aNote.cx, aNote.cy, 1000n, b.op.a.sigR, b.op.a.sigZ, ctx), 'A sigma opens under the bound bond context');
  assert.ok(ux.pool.verifyOpeningSigma(bNote.cx, bNote.cy, 1000n, b.op.b.sigR, b.op.b.sigZ, ctx), 'B sigma opens under the bound bond context');
  // a missing controller is refused (no silent unbonded add)
  assert.throws(() => ux.buildLpBondOp({ walletPriv, aNote, bNote, reserveAPre: 10000n, reserveBPre: 10000n, sharesPre: 10000n }), /controller/);
});

// OP_LP_BOND → OP_FARM_HARVEST → OP_FARM_UNBOND at the witness level: the receipt a bond emits is owned by a real
// BIP-340 key that re-derives from the wallet key + the position, so the harvest and unbond the guest authorizes
// against that receipt can actually be signed, and the bond ships the one memo its one receipt leaf needs.
test('lpBond: receipt key + nonce re-derive from the wallet, and the bond → harvest → unbond witnesses verify', async () => {
  const { makeConfidentialFarm } = await import('../dapp/confidential-farm.js');
  const { verifySchnorr } = await import('../dapp/bulletproofs.js');
  const submitted = [];
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const reserves = '0x' + [1n, 0n, 0n, 10000n, 10000n, 30n, 10000n].map(w).join('');
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const obj = String(url).includes('/confidential/submit') ? (submitted.push(body), { jobId: 'j', status: 'settled' })
      : String(url).includes('/confidential/status') ? { jobId: 'j', status: 'settled' }
      : { result: body && body.method === 'eth_call' ? reserves : '0x0' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  } });
  const pool = ux.pool;
  const farm = makeConfidentialFarm({ keccak256: keccak_256, pool });
  const walletPriv = '0x' + 'c4'.repeat(32);
  const id = ux.identity(walletPriv);
  const controller = '0x' + 'fa'.repeat(20);
  const assetLow = '0x0a' + 'a'.repeat(62), assetHigh = '0x' + 'b0'.repeat(32);
  const tree = new pool.Tree();
  const mk = (asset, idx) => {
    const dn = pool.deriveNote(id.priv, asset, idx);
    const blinding = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
    const owner = pool.nkToOwner(dn.secret);
    const c = pool.commitXY(1000n, blinding);
    const leafIndex = tree.insert(pool.leaf(asset, c.cx, c.cy, owner));
    return { asset, value: '1000', ...c, owner, secret: dn.secret, blinding, leafIndex };
  };
  const aNote = mk(assetLow, 0), bNote = mk(assetHigh, 1);
  for (const n of [aNote, bNote]) { n.path = tree.rootAndPath(n.leafIndex).path; n.root = tree.root(); }

  const r = await ux.lpBond({ walletPriv, controller, aNote, bNote, feeBps: 30 });
  const sub = submitted.at(-1);
  assert.equal(sub.type, 'lpbond');
  assert.equal(sub.memos.length, 1, 'one memo for the one receipt leaf');
  assert.equal(sub.memos[0], '0x', 'the receipt memo is the seed-derived empty memo');
  assert.equal(sub.op.owner, r.receiptOwner);
  assert.notEqual(r.receiptOwner.toLowerCase(), id.owner.toLowerCase(), 'receipt is not owned by the wallet nk-hash owner');

  // Recovery: the position re-derives from the wallet key + (controller, lpAsset, spent A note leaf) alone.
  const pos = ux.lpBondPosition({ walletPriv, controller, lpAsset: r.lpAsset, anchorLeaf: pool.leaf(assetLow, aNote.cx, aNote.cy, aNote.owner) });
  assert.equal(pos.owner, r.receiptOwner, 'receipt owner re-derives');
  assert.equal(pos.nonce, r.bondNonce, 'bond nonce re-derives');
  const again = ux.buildLpBondOp({ walletPriv, controller, aNote, bNote, feeBps: 30, reserveAPre: 10000n, reserveBPre: 10000n, sharesPre: 10000n });
  assert.equal(again.bondNonce, r.bondNonce, 'deterministic nonce');
  const other = ux.lpBondPosition({ walletPriv, controller, lpAsset: r.lpAsset, anchorLeaf: '0x' + '99'.repeat(32) });
  assert.notEqual(other.owner, pos.owner, 'a different position gets a different key');
  assert.notEqual(other.nonce, pos.nonce, 'and a different nonce');
  // The owner is a real x-only key whose discrete log is ownerPriv.
  const xOnly = '0x' + Buffer.from(secp.getPublicKey(Buffer.from(pos.ownerPriv.slice(2), 'hex'), true).slice(1)).toString('hex');
  assert.equal(xOnly, pos.owner, 'owner = x(ownerPriv·G)');

  const controller32 = '0x' + '00'.repeat(12) + controller.slice(2);
  const receipt = pool.farmReceiptLeaf(controller32, r.lpAsset, r.dShares, pos.owner, pos.nonce);
  assert.equal(receipt, r.receiptLeaf, 'the receipt the bond emits');
  const rTree = new pool.Tree(); const ri = rTree.insert(receipt); const { root: rRoot, path: rPath } = rTree.rootAndPath(ri);
  const b32 = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex'));

  const rewardAsset = farm.debtAssetId(controller), reward = 250n, rb = 9n;
  const rewardOwner = pool.nkToOwner('0x' + '11'.repeat(32));
  const hv = farm.buildHarvestOp({ chainBinding: '0x' + '00'.repeat(32), spendRoot: rRoot, controller, owner: pos.owner, ownerPriv: pos.ownerPriv, rewardOwner, shares: r.dShares, nonce: pos.nonce, harvestNonce: '0x' + 'b2'.repeat(32), reward, oldIndex: ri, oldPath: rPath, lpAsset: r.lpAsset, rewardAsset, rewardNote: { ...pool.commitXY(reward, rb), blinding: rb } });
  assert.equal(pool.merkleRootFrom(receipt, ri, rPath).toLowerCase(), rRoot.toLowerCase(), 'harvest proves the bond receipt');
  const hMsg = pool.evmLpHarvestOwnerMsg({ farmId: controller32, oldLeaf: receipt, reward, fee: 0n, newNonce: '0x' + 'b2'.repeat(32), rewardAsset, rewardCx: hv.rewardCx, rewardCy: hv.rewardCy, rewardOwner });
  assert.ok(verifySchnorr(Uint8Array.from(Buffer.from(hv.ownerSig.slice(2), 'hex')), hMsg, b32(pos.owner)), 'harvest owner signature verifies under the receipt owner');

  const lpOwner = pool.nkToOwner('0x' + '22'.repeat(32)), ub = 11n;
  const un = farm.buildUnbondOp({ chainBinding: '0x' + '00'.repeat(32), spendRoot: rRoot, controller, owner: pos.owner, ownerPriv: pos.ownerPriv, lpOwner, shares: r.dShares, nonce: pos.nonce, lpAsset: r.lpAsset, oldIndex: ri, oldPath: rPath, releaseNote: { ...pool.commitXY(r.dShares, ub), blinding: ub } });
  const uMsg = pool.evmLpUnbondOwnerMsg({ farmId: controller32, receipt, shares: r.dShares, fee: 0n, lpAsset: r.lpAsset, releaseCx: un.releaseCx, releaseCy: un.releaseCy, releaseOwner: lpOwner });
  assert.ok(verifySchnorr(Uint8Array.from(Buffer.from(un.ownerSig.slice(2), 'hex')), uMsg, b32(pos.owner)), 'unbond owner signature verifies under the receipt owner');
  // A signature from the wallet-constant identity key does not authorize the receipt.
  const { signSchnorr } = await import('../dapp/bulletproofs.js');
  assert.ok(!verifySchnorr(signSchnorr(uMsg, id.priv), uMsg, b32(pos.owner)), 'the identity key cannot unbond');
});

test('buildUnwrap: the opening sigma binds recipient + fee, and no raw blinding reaches the settler', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '55'.repeat(32);
  const w = ux.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];

  const recip = '0x' + 'cc'.repeat(20);
  const built = ux.buildUnwrap({ note, walletPriv, recipient: recip, selfSettle: true }); // fee = 0
  const op = built.op;
  // the gasless-exit op hands the box the SIGMA, never the raw blinding (the redirect/fee-pad surface)
  assert.equal(op.blinding, undefined, 'no raw blinding handed to the settler');
  assert.ok(op.sigR && op.sigZ, 'opening sigma (R, z) present');

  const pool = ux.pool;
  const dl = BigInt(op.deadline);
  const ctxOf = (recipientHex, feeUnits, deadlineUnits = dl) => pool.intentContext(
    'tacit-unwrap-intent-v1', op.chainBinding, note.asset,
    '0x' + '0'.repeat(24) + recipientHex.replace(/^0x/, ''),
    [[note.cx, note.cy, note.owner]], [BigInt(note.value), feeUnits, deadlineUnits],
  );
  // verifies against the committed (recipient, value, fee, deadline)
  assert.ok(pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), op.sigR, op.sigZ, ctxOf(recip, 0n)),
    'sigma opens the note under the committed intent');
  // a settler redirecting the recipient to itself yields a DIFFERENT context → the sigma fails
  assert.ok(!pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), op.sigR, op.sigZ, ctxOf('0x' + 'ee'.repeat(20), 0n)),
    'redirecting the recipient breaks the sigma (no settler theft)');
  // padding the fee (moving value from the recipient leg to the settler) also breaks the sigma
  assert.ok(!pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), op.sigR, op.sigZ, ctxOf(recip, BigInt(note.value))),
    'padding the fee breaks the sigma');
  // stretching the expiry (a box submitting the exit past its deadline) also breaks the sigma
  assert.ok(!pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), op.sigR, op.sigZ, ctxOf(recip, 0n, dl + 86400n)),
    'stretching the deadline breaks the sigma (no stale-submit grief)');
});

// wrapLp / wrapSwap spend PENDING deposits created by buildWrap, so the deposit id they recompute (and the owner
// every sigma binds) must be the per-note owner that wrap committed — nkToOwner(deriveNote(asset, index).secret) —
// or the guest looks up a deposit that was never made and the settle reverts.
function depositOpMock(captured) {
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const reserves = '0x' + [1n, 0n, 0n, 10_000_000n, 10_000_000n, 30n, 10_000_000n].map(w).join('');
  return async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    let obj;
    if (String(url).includes('/confidential/submit')) { captured.push(body); obj = { jobId: 'j1', status: 'settled' }; }
    else if (String(url).includes('/confidential/status')) obj = { jobId: 'j1', status: 'settled' };
    else obj = { result: body && body.method === 'eth_call' ? reserves : '0x0' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
}

test('wrapSwap / wrapLp: deposit ids and deposit owners match the notes buildWrap committed', async () => {
  const captured = [];
  const ux = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: depositOpMock(captured) }); // mainnet registers several pool assets
  const walletPriv = '0x' + '77'.repeat(32);
  const amountWei = '1000000000000000';
  const id = ux.identity(walletPriv);
  const other = ux.assets.find((a) => a.ticker !== 'cETH' && a.ticker !== 'TAC').ticker;

  const wEth = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 3 });
  await ux.wrapSwap({ walletPriv, fromTicker: 'cETH', toTicker: other, amountWei, index: 3 });
  const swapOp = captured.at(-1).op;
  assert.equal(swapOp.depositIds[0], wEth.depositId, 'wrap-swap spends the deposit wrap created');
  assert.equal(swapOp.deposit.owner, wEth.note.owner, 'wrap-swap deposit owner is the per-note wrap owner');
  assert.notEqual(swapOp.deposit.owner, id.owner, 'not the wallet-constant identity owner');

  const wUsd = ux.buildWrap({ walletPriv, amountWei, ticker: other, index: 1 });
  const lpRes = await ux.wrapLp({ walletPriv, aTicker: 'cETH', bTicker: other, aAmountWei: amountWei, bAmountWei: amountWei, aIndex: 3, bIndex: 1 });
  const lpOp = captured.at(-1).op;
  const byAsset = { [wEth.note.asset.toLowerCase()]: wEth, [wUsd.note.asset.toLowerCase()]: wUsd };
  const legA = byAsset[lpOp.assetA.toLowerCase()], legB = byAsset[lpOp.assetB.toLowerCase()];
  assert.deepEqual(lpOp.depositIds, [legA.depositId, legB.depositId], 'wrap-lp spends both wrap deposits, in canonical order');
  assert.equal(lpOp.a.owner, legA.note.owner, 'leg A owner is its wrap owner');
  assert.equal(lpOp.b.owner, legB.note.owner, 'leg B owner is its wrap owner');
  // The leg sigmas open under the context the guest rebuilds from those owners.
  const pool = ux.pool;
  const ctx = pool.intentContext('tacit-wrap-lp-v1', lpOp.chainBinding, lpOp.assetA, lpOp.assetB,
    [[lpOp.a.cx, lpOp.a.cy, legA.note.owner], [lpOp.b.cx, lpOp.b.cy, legB.note.owner], [lpOp.share.cx, lpOp.share.cy, lpOp.share.owner], [lpRes.lpAsset, lpRes.pid, lpOp.share.owner]],
    [BigInt(lpOp.a.value), BigInt(lpOp.b.value), lpRes.dShares, 0n, 0n]);
  assert.ok(pool.verifyOpeningSigma(lpOp.a.cx, lpOp.a.cy, BigInt(lpOp.a.value), lpOp.a.sigR, lpOp.a.sigZ, ctx), 'leg A sigma binds the wrap owner');
  assert.ok(pool.verifyOpeningSigma(lpOp.b.cx, lpOp.b.cy, BigInt(lpOp.b.value), lpOp.b.sigR, lpOp.b.sigZ, ctx), 'leg B sigma binds the wrap owner');
});

// Every note a route mints gets its own fresh nk (sealed in its memo), never the wallet-constant identity owner
// whose nk would reach the relay on the note's next spend. buildRoute refuses a partial spend today, so the
// change path is asserted to fail closed and the routed output is checked on a whole-note route.
test('route: minted notes use a fresh per-note nk, never the identity owner', async () => {
  const captured = [];
  const ux = makeConfidentialPoolUx({ ...deps, network: 'mainnet', fetchImpl: depositOpMock(captured) });
  const walletPriv = '0x' + '78'.repeat(32);
  const id = ux.identity(walletPriv);
  const w = ux.buildWrap({ walletPriv, amountWei: '10000000000000000', ticker: 'cETH', index: 0 });
  const tree = new ux.pool.Tree();
  const leafIndex = tree.insert(w.leaf);
  const inNote = { ...w.note, leafIndex, path: tree.rootAndPath(leafIndex).path, root: tree.root() };
  const other = ux.assets.find((a) => a.ticker !== 'cETH' && a.ticker !== 'TAC').assetId;
  const path = [{ assetNext: other, feeBps: 30 }];
  await assert.rejects(ux.route({ walletPriv, inNote, amountIn: BigInt(inNote.value) / 2n, path, minOut: 0n }), /partial-spend change/);
  await ux.route({ walletPriv, inNote, amountIn: BigInt(inNote.value), path, minOut: 0n });
  const sub = captured.at(-1);
  assert.equal(sub.memos.length, 1, 'whole-note route: one routed output, sealed');
  const out = sub.op.out;
  assert.notEqual(String(out.owner).toLowerCase(), id.owner.toLowerCase(), 'output is not minted to the identity owner');
  const opened = ux.indexer._memo.openMemo(walletPriv, ux.pool.leaf(other, out.cx, out.cy, out.owner), sub.memos[0]);
  assert.ok(opened, 'the output memo opens for the wallet');
  assert.equal(String(ux.pool.nkToOwner(opened.secret)).toLowerCase(), String(out.owner).toLowerCase(), 'the sealed nk owns the output leaf');
});

test('crossOut: a destination owner is required for every destination chain', async () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => { throw new Error('no network expected'); } });
  const walletPriv = '0x' + '79'.repeat(32);
  const w = ux.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  const note = { ...w.note, leafIndex: 0, path: ux.pool.zeros, root: '0x' + '00'.repeat(32), nullifier: '0x' + '11'.repeat(32) };
  await assert.rejects(ux.crossOut({ walletPriv, notes: [note], destChain: 8453 }), /destOwner/);
  await assert.rejects(ux.crossOut({ walletPriv, notes: [note], destChain: 1 }), /destOwner/);
});

// After a relayed settle, the memos the pool emitted for our leaves must equal the memos sealed locally: the relay
// picks the memo hashes it proves, so a substituted memo still settles, and only this comparison notices.
test('relayed settle: emitted memos are compared byte-for-byte with the sealed ones', async () => {
  const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
  const encodeLeavesInserted = (leaves, memos) => {
    const lv = [w32(leaves.length), ...leaves.map((l) => String(l).replace(/^0x/, '').padStart(64, '0'))].join('');
    const bodies = memos.map((m) => { const h = String(m).replace(/^0x/, ''); const len = h.length / 2; return w32(len) + h.padEnd(Math.ceil(len / 32) * 64, '0'); });
    let off = 32 * memos.length; const heads = [];
    for (const b of bodies) { heads.push(w32(off)); off += b.length / 2; }
    const mv = w32(memos.length) + heads.join('') + bodies.join('');
    return '0x' + w32(64) + w32(64 + lv.length / 2) + lv + mv;
  };
  const run = async (tamper) => {
    const state = {};
    const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      let obj;
      if (String(url).includes('/confidential/submit')) { state.sub = body; obj = { jobId: 'j', status: 'pending' }; }
      else if (String(url).includes('/confidential/status')) obj = { jobId: 'j', status: 'settled', txHash: '0x' + 'ab'.repeat(32) };
      else if (body && body.method === 'eth_getTransactionReceipt') {
        const { op, memos } = state.sub;
        const leaves = op.outputs.map((o) => state.pool.leaf(op.asset, o.cx, o.cy, o.owner));
        const shipped = tamper ? [memos[1], memos[0]] : memos;
        obj = { result: { logs: [{ address: state.poolAddr, topics: [state.topic, '0x' + w32(5)], data: encodeLeavesInserted(leaves, shipped) }] } };
      } else obj = { result: '0x0' };
      return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
    } });
    state.pool = ux.pool; state.poolAddr = ux.cfg.pool;
    state.topic = makeConfidentialEvmLogTopic();
    const walletPriv = '0x' + '5a'.repeat(32);
    const { note, recipientPubHex } = transferFixture(ux, walletPriv);
    return ux.transfer({ walletPriv, notes: [note], recipientPubHex, amount: 40000n, waitOpts: { intervalMs: 0, sleep: async () => {} } });
  };
  const good = await run(false);
  assert.equal(good.memoCheck.ok, true, 'identical memos pass');
  await assert.rejects(run(true), (e) => /emitted memos differ/.test(e.message) && e.memoCheck.mismatched.length === 2 && Array.isArray(e.sealedMemos));
});

// A memo the relay replaced leaves the chain unable to open the note. The sealed memos are kept on the device under
// the settle's tx hash, and the balance scan applies them, so the note stays in the balance there.
test('relayed settle: a replaced memo is kept locally and the balance scan still recovers the note', async () => {
  const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
  const encodeLeavesInserted = (leaves, memos) => {
    const lv = [w32(leaves.length), ...leaves.map((l) => String(l).replace(/^0x/, '').padStart(64, '0'))].join('');
    const bodies = memos.map((m) => { const h = String(m).replace(/^0x/, ''); const len = h.length / 2; return w32(len) + h.padEnd(Math.ceil(len / 32) * 64, '0'); });
    let off = 32 * memos.length; const heads = [];
    for (const b of bodies) { heads.push(w32(off)); off += b.length / 2; }
    const mv = w32(memos.length) + heads.join('') + bodies.join('');
    return '0x' + w32(64) + w32(64 + lv.length / 2) + lv + mv;
  };
  const store = new Map();
  const prior = globalThis.localStorage;
  globalThis.localStorage = {
    get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
  };
  try {
    const state = {};
    const topic = makeConfidentialEvmLogTopic();
    const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      let obj;
      if (String(url).includes('/confidential/submit')) { state.sub = body; obj = { jobId: 'j', status: 'pending' }; }
      else if (String(url).includes('/confidential/status')) obj = { jobId: 'j', status: 'settled', txHash: '0x' + 'ab'.repeat(32) };
      else if (body && body.method === 'eth_getTransactionReceipt') {
        // Every memo shipped is the other output's memo.
        const { op, memos } = state.sub;
        const leaves = op.outputs.map((o) => ux.pool.leaf(op.asset, o.cx, o.cy, o.owner));
        state.log = { address: ux.cfg.pool, topics: [topic, '0x' + w32(0)], data: encodeLeavesInserted(leaves, [memos[1], memos[0]]), blockNumber: '0x1', transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0' };
        obj = { result: { logs: [state.log] } };
      }
      else if (body && body.method === 'eth_blockNumber') obj = { result: '0x' + Number(DEPLOY_BLOCK).toString(16) };
      else if (body && body.method === 'eth_getLogs') obj = { result: state.log ? [state.log] : [] };
      else obj = { result: '0x0' };
      return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
    } });
    const walletPriv = '0x' + '5c'.repeat(32);
    const { note, recipientPubHex } = transferFixture(ux, walletPriv);
    const scanKey = ux.identity(walletPriv).priv;
    await assert.rejects(
      ux.transfer({ walletPriv, notes: [note], recipientPubHex, amount: 40000n, waitOpts: { intervalMs: 0, sleep: async () => {} } }),
      (e) => /emitted memos differ/.test(e.message));
    assert.ok([...store.keys()].some((k) => k.startsWith('tacit:unrecoverable-memos:')), 'the sealed memos are kept under the settle tx hash');
    const withSaved = await ux.balance(scanKey);
    assert.equal(withSaved.notes.length, 2, 'both outputs are recovered from the kept memos');
    store.clear();
    const without = await ux.balance(scanKey);
    assert.equal(without.notes.length, 0, 'the chain memos alone recover neither output');
  } finally {
    globalThis.localStorage = prior;
  }
});

// The change note of a send-and-unwrap is checked like every other relayed leaf: the memo the settle emitted must be
// the one sealed here.
test('sendUnwrap: the emitted change memo is compared with the sealed one', async () => {
  const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
  const encodeLeavesInserted = (leaves, memos) => {
    const lv = [w32(leaves.length), ...leaves.map((l) => String(l).replace(/^0x/, '').padStart(64, '0'))].join('');
    const bodies = memos.map((m) => { const h = String(m).replace(/^0x/, ''); const len = h.length / 2; return w32(len) + h.padEnd(Math.ceil(len / 32) * 64, '0'); });
    let off = 32 * memos.length; const heads = [];
    for (const b of bodies) { heads.push(w32(off)); off += b.length / 2; }
    return '0x' + w32(64) + w32(64 + lv.length / 2) + lv + w32(memos.length) + heads.join('') + bodies.join('');
  };
  const run = async (tamper) => {
    const state = {};
    const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      let obj;
      if (String(url).includes('/confidential/submit')) { state.sub = body; obj = { jobId: 'j', status: 'pending' }; }
      else if (String(url).includes('/confidential/status')) obj = { jobId: 'j', status: 'settled', txHash: '0x' + 'ab'.repeat(32) };
      else if (body && body.method === 'eth_getTransactionReceipt') {
        const { op, memos } = state.sub;
        const leaf = state.pool.leaf(op.asset, op.change[0].cx, op.change[0].cy, op.change[0].owner);
        const shipped = tamper ? ['0x' + 'ee'.repeat(169)] : memos;
        obj = { result: { logs: [{ address: state.poolAddr, topics: [state.topic, '0x' + w32(1)], data: encodeLeavesInserted([leaf], shipped) }] } };
      } else obj = { result: '0x0' };
      return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
    } });
    state.pool = ux.pool; state.poolAddr = ux.cfg.pool; state.topic = makeConfidentialEvmLogTopic();
    const walletPriv = '0x' + '5d'.repeat(32);
    const { note } = transferFixture(ux, walletPriv);
    return ux.sendUnwrap({ note, walletPriv, recipient: '0x' + '12'.repeat(20), amount: BigInt(note.value) / 2n, feeOpts: { minFee: 1n }, waitOpts: { intervalMs: 0, sleep: async () => {} } });
  };
  const good = await run(false);
  assert.equal(good.memoCheck.ok, true, 'the sealed change memo was emitted unchanged');
  await assert.rejects(run(true), (e) => /emitted memos differ/.test(e.message) && Array.isArray(e.sealedMemos));
});

// Not waiting for the settle must not quietly skip that comparison: the result says the check has not run, and
// carries the check itself so a caller can run it once the settle lands.
test('sendUnwrap: a non-waiting exit reports the memo check as unrun, and verifyMemos() runs it later', async () => {
  const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
  const encodeLeavesInserted = (leaves, memos) => {
    const lv = [w32(leaves.length), ...leaves.map((l) => String(l).replace(/^0x/, '').padStart(64, '0'))].join('');
    const bodies = memos.map((m) => { const h = String(m).replace(/^0x/, ''); const len = h.length / 2; return w32(len) + h.padEnd(Math.ceil(len / 32) * 64, '0'); });
    let off = 32 * memos.length; const heads = [];
    for (const b of bodies) { heads.push(w32(off)); off += b.length / 2; }
    return '0x' + w32(64) + w32(64 + lv.length / 2) + lv + w32(memos.length) + heads.join('') + bodies.join('');
  };
  const run = async (tamper) => {
    const state = {};
    const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      let obj;
      if (String(url).includes('/confidential/submit')) { state.sub = body; obj = { jobId: 'j', status: 'pending' }; }
      else if (String(url).includes('/confidential/status')) obj = { jobId: 'j', status: 'settled', txHash: '0x' + 'ab'.repeat(32) };
      else if (body && body.method === 'eth_getTransactionReceipt') {
        const { op, memos } = state.sub;
        const leaf = state.pool.leaf(op.asset, op.change[0].cx, op.change[0].cy, op.change[0].owner);
        obj = { result: { logs: [{ address: state.poolAddr, topics: [state.topic, '0x' + w32(1)], data: encodeLeavesInserted([leaf], tamper ? ['0x' + 'ee'.repeat(169)] : memos) }] } };
      } else obj = { result: '0x0' };
      return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
    } });
    state.pool = ux.pool; state.poolAddr = ux.cfg.pool; state.topic = makeConfidentialEvmLogTopic();
    const walletPriv = '0x' + '5e'.repeat(32);
    const { note } = transferFixture(ux, walletPriv);
    return ux.sendUnwrap({ note, walletPriv, recipient: '0x' + '12'.repeat(20), amount: BigInt(note.value) / 2n, feeOpts: { minFee: 1n }, wait: false });
  };
  const r = await run(false);
  assert.equal(r.memoCheck.ok, null, 'nothing has been compared yet, and the result says so');
  assert.match(r.memoCheck.reason, /verifyMemos/);
  assert.equal(typeof r.verifyMemos, 'function');
  const checked = await r.verifyMemos();
  assert.equal(checked.memoCheck.ok, true, 'the same comparison, on demand');
  const bad = await run(true);
  await assert.rejects(bad.verifyMemos(), (e) => /emitted memos differ/.test(e.message) && Array.isArray(e.sealedMemos));
});

function makeConfidentialEvmLogTopic() {
  return '0x' + Buffer.from(keccak_256(new TextEncoder().encode('LeavesInserted(uint256,bytes32[],bytes[])'))).toString('hex');
}

// Fast-lane exit: Bitcoin-homed notes move into a native note through an authenticated OP_TRANSFER shaped for
// exec-fastlane. Each input must be a btc_note_leaf_bound member of the Bitcoin pool root, unspent in the
// reflected spent set, and signed by its Taproot key over btc_note_spend_msg — checked here as the guest does.
test('fastlane exit: authenticated transfer witness (bound leaf, non-membership, BIP-340 spend sig, transfer kernel)', async () => {
  const { verifySchnorr } = await import('../dapp/bulletproofs.js');
  const { makeConfidentialTransfer } = await import('../dapp/confidential-transfer.js');
  const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
  const submitted = [];
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const obj = String(url).includes('/confidential/submit') ? (submitted.push(body), { jobId: 'j', status: 'proven' })
      : String(url).includes('/confidential/status') ? { jobId: 'j', status: 'proven', publicValues: '0xaa', proof: '0xbb' }
      : { result: body && body.method === 'eth_gasPrice' ? '0x3b9aca00' : body && body.method === 'eth_sendRawTransaction' ? '0x' + 'cd'.repeat(32) : '0x0' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  } });
  const pool = ux.pool;
  const walletPriv = '0x' + '5b'.repeat(32);
  const asset = ux.assets[0].assetId;
  const hb = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex'));
  const authPriv = '0x' + '3c'.repeat(32);
  const authKey = '0x' + Buffer.from(secp.getPublicKey(hb(authPriv), true).slice(1)).toString('hex');
  // Build the Bitcoin pool tree under this deployment's chain binding, as the reflection does.
  const chainBinding = (() => { const w = ux.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: ux.assets[0].ticker }); return w.wrapOp.chainBinding; })();
  const mk = (value, blinding) => ({ asset, value: String(value), blinding: '0x' + BigInt(blinding).toString(16).padStart(64, '0'), ...pool.commitXY(value, '0x' + BigInt(blinding).toString(16).padStart(64, '0')) });
  const notes = [mk(70000n, 11n), mk(30000n, 12n)];
  const tree = new pool.Tree();
  notes.forEach((n) => { n.leafIndex = tree.insert(pool.btcNoteLeafBound(asset, n.cx, n.cy, authKey, chainBinding)); });
  const spendRoot = tree.root();
  notes.forEach((n) => { n.path = tree.rootAndPath(n.leafIndex).path; });
  const spent = new pool.Tree();
  const MAX = '0x' + 'ff'.repeat(32), ZERO = '0x' + '00'.repeat(32);
  spent.insert(pool.imtLeaf(ZERO, MAX));
  const bitcoinSpentRoot = spent.root();
  notes.forEach((n) => { n.low = { value: ZERO, next: MAX, index: 0, path: spent.rootAndPath(0).path }; });

  const fee = 100n;
  const b = ux.buildFastlaneExitOp({ walletPriv, notes, authPriv, spendRoot, bitcoinSpentRoot, fee });
  const t = b.op.transfer;
  assert.equal(b.op.bitcoinSpentRoot, bitcoinSpentRoot);
  assert.equal(t.inputs.length, 2); assert.equal(t.outputs.length, 1);
  const outLeaves = t.outputs.map((o) => pool.leaf(asset, o.cx, o.cy, o.owner));
  assert.deepEqual(b.leaves, outLeaves);
  const OP_ID = '0x' + Buffer.from('tacit.op.transfer'.padEnd(32, '\0')).toString('hex');
  for (const inp of t.inputs) {
    assert.equal(inp.owner, authKey, 'input owner is the Taproot authority key');
    const lf = pool.btcNoteLeafBound(asset, inp.cx, inp.cy, inp.owner, b.op.chainBinding);
    const msg = pool.btcNoteSpendMsg(b.op.chainBinding, OP_ID, lf, pool.nullifier(lf), outLeaves, fee, 0n);
    assert.ok(verifySchnorr(hb(inp.sig), hb(msg), hb(authKey)), 'BIP-340 spend signature verifies under the note key');
    assert.ok(inp.low && inp.low.path.length === 32, 'non-membership witness carried per input');
  }
  const Point = ct.H.constructor; // the transfer module's own point class
  const kernel = { R: Point.fromHex(t.kernel.R.slice(2)), z: BigInt(t.kernel.z) };
  const pt = (o) => Point.fromAffine({ x: BigInt(o.cx), y: BigInt(o.cy) });
  assert.ok(ct.verifyKernel({ inC: t.inputs.map(pt), outC: t.outputs.map(pt), fee, kernel, outLeaves, domain: 'transfer' }), 'kernel verifies under the OP_TRANSFER domain with outputs bound');
  assert.ok(!ct.verifyKernel({ inC: t.inputs.map(pt), outC: t.outputs.map(pt), fee, kernel, outLeaves }), 'and not under the generic domain');
  const opened = ux.indexer._memo.openMemo(walletPriv, outLeaves[0], b.memos[0]);
  assert.ok(opened && opened.value === 99900n, 'the native output (value − fee) is recoverable from its memo');

  // Every precondition the guest enforces is checked before proving.
  assert.throws(() => ux.buildFastlaneExitOp({ walletPriv, notes, authPriv, spendRoot, bitcoinSpentRoot: ZERO, fee }), /bitcoinSpentRoot/);
  assert.throws(() => ux.buildFastlaneExitOp({ walletPriv, notes, authPriv: '0x' + '3d'.repeat(32), spendRoot, bitcoinSpentRoot, fee }), /not a member/);
  assert.throws(() => ux.buildFastlaneExitOp({ walletPriv, notes, authPriv, spendRoot: '0x' + '12'.repeat(32), bitcoinSpentRoot, fee }), /not a member/);
  const nuSpent = pool.nullifier(pool.btcNoteLeafBound(asset, notes[0].cx, notes[0].cy, authKey, chainBinding));
  const bad = notes.map((n) => ({ ...n, low: { ...n.low, next: nuSpent } }));
  assert.throws(() => ux.buildFastlaneExitOp({ walletPriv, notes: bad, authPriv, spendRoot, bitcoinSpentRoot, fee }), /non-membership/);

  // Dispatch: the relay type the prover maps to exec-fastlane.
  await ux.fastlaneExit({ walletPriv, notes, authPriv, spendRoot, bitcoinSpentRoot, fee: 0n, waitOpts: { intervalMs: 0, sleep: async () => {} } });
  assert.equal(submitted.at(-1).type, 'fastlane');
  assert.equal(submitted.at(-1).mode, 'prove', 'self-relay by default: the box proves, the user settles');
});

// ── self-settle submit: priority tip and the genesis-LP entrypoint ──
const settleStub = (tipHex) => async (url, opts) => {
  const m = JSON.parse(opts.body).method;
  const result = m === 'eth_getTransactionCount' ? '0x0' : m === 'eth_gasPrice' ? '0x3b9aca00' : m === 'eth_maxPriorityFeePerGas' ? tipHex : '0x';
  return { ok: true, json: async () => ({ result }) };
};
const settleArgs = { settlerPriv: '0x' + '11'.repeat(32), publicValues: '0x' + 'ab'.repeat(40), proof: '0x' + 'cd'.repeat(40), broadcast: false };

test('submitSettle: priority tip follows the node suggestion and is capped at 1.5 gwei', async () => {
  const low = await makeConfidentialPoolUx({ ...deps, fetchImpl: settleStub('0x2faf080') }).submitSettle(settleArgs); // 0.05 gwei
  assert.ok(low.signedRaw.includes('8402faf080'), 'signed tx carries the node-suggested 0.05 gwei tip');
  const high = await makeConfidentialPoolUx({ ...deps, fetchImpl: settleStub('0xb2d05e00') }).submitSettle(settleArgs); // 3 gwei
  assert.ok(high.signedRaw.includes('8459682f00'), 'a suggestion above the cap is clamped to 1.5 gwei');
});

test('submitSettle: a founding LP add goes through createPairAndSettle, an ordinary settle stays settle()', async () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: settleStub('0x2faf080') });
  const sel = (sig) => Buffer.from(keccak_256(Buffer.from(sig))).toString('hex').slice(0, 8);
  const A = '0x' + '01'.repeat(32), B = '0x' + '02'.repeat(32);
  const plain = await ux.submitSettle(settleArgs);
  assert.ok(plain.signedRaw.includes(sel('settle(bytes,bytes,bytes[])')), 'ordinary settle keeps the settle selector');
  assert.ok(!plain.signedRaw.includes(sel('createPairAndSettle(bytes32,bytes32,uint32,bytes,bytes,bytes[])')));
  const found = await ux.submitSettle({ ...settleArgs, pair: { assetA: A, assetB: B, feeBps: 30 } });
  assert.ok(found.signedRaw.includes(sel('createPairAndSettle(bytes32,bytes32,uint32,bytes,bytes,bytes[])')), 'founding add uses createPairAndSettle');
  assert.ok(found.signedRaw.includes('01'.repeat(32) + '02'.repeat(32) + '0'.repeat(62) + '1e'), 'assetA, assetB and feeBps=30 ride the head words');
});
