// dapp/community-ops.js: the calls the community ops page and tools/community-runner.mjs both build, and the work both pass over.
// Proofs of Bitcoin's state (the attest calldata, which published proof is offered, the pool's refusals in words, the ancestry
// checkpoint), and the open board (what a job pays its sender, which job is sent next, the board and landing reads). The fee and
// settle encodings are checked against a real mainnet settle, and the pick against the relay's own (worker-relay/src/lib/open-board.js).
//
// Run: node --test tests/community-ops.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import * as ops from '../dapp/community-ops.js';
import { pickOpen } from '../worker-relay/src/lib/open-board.js';
import { settleCalldata as workerSettleCalldata } from '../worker/src/confidential-open.js';
import { CONFIDENTIAL_DEPLOYMENTS } from '../dapp/confidential-deployments.js';

const sel = (sig) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).subarray(0, 4).toString('hex');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const ETH = ops.ETH_ASSET_ID, TAC = '0x' + 'f0'.repeat(32);

// A PublicValues encoding with the fields community-ops reads: head word 8 the offset of `fees`, word 16 the deadline.
function pv({ fees = [], deadline = 0 } = {}) {
  const head = Array.from({ length: 19 }, () => word(0));
  head[7] = word(19 * 32);                                   // word 8 counting the tuple offset as word 0
  head[15] = word(deadline);                                 // word 16
  return '0x' + word(32) + head.join('') + word(fees.length) + fees.map(([a, v]) => a.slice(2) + word(v)).join('');
}
const job = (id, { fee = 0n, asset = ETH, since = 1000, status = 'open', deadline = 0, expiresAt = 0, feeUsd = 0, memos = [] } = {}) => ({
  jobId: '0x' + word(id), type: 'transfer', status, publicValues: pv({ fees: fee ? [[asset, fee]] : [], deadline }), proof: '0x' + 'cd'.repeat(260),
  memos, openSince: since, expiresAt, feeUsd,
});
const unitsFor = (wei) => wei / ops.ETH_UNIT_SCALE;          // a fee leg's in-pool value for `wei` of ETH

// A real mainnet settle (a relay cut that paid a tETH fee of 41,000 units), split back into its three arguments.
function splitSettle(data) {
  const h = data.trim().replace(/^0x/, '').slice(8);
  const w = (i) => Number(BigInt('0x' + h.slice(i * 64, i * 64 + 64)));
  const bytesAt = (off) => { const n = w(off / 32); return '0x' + h.slice(off * 2 + 64, off * 2 + 64 + n * 2); };
  const memosOff = w(2), count = w(memosOff / 32);
  const memos = [];
  for (let i = 0; i < count; i++) memos.push(bytesAt(memosOff + 32 + w(memosOff / 32 + 1 + i)));
  return { publicValues: bytesAt(w(0)), proof: bytesAt(w(1)), memos };
}
const REAL = readFileSync(new URL('./fixtures/settle-split-0xf033a9be.hex', import.meta.url), 'utf8').trim();
const real = splitSettle(REAL);

test('the selectors are the pool functions they name, and tETH is the deployments’ native asset', () => {
  assert.equal(ops.SEL_ATTEST, sel('attestBitcoinStateProven(bytes,bytes)'));
  assert.equal(ops.SEL_ATTESTED_DIGEST, sel('attestedReflectionDigest()'));
  assert.equal(ops.SEL_ANCESTRY, sel('advanceReflectionAncestry()'));
  assert.equal(ops.settleCalldata(real).slice(0, 10), sel('settle(bytes,bytes,bytes[])'));
  const eth = CONFIDENTIAL_DEPLOYMENTS.mainnet.assets.find((a) => a.native);
  assert.equal(eth.assetId, ops.ETH_ASSET_ID);
  assert.equal(BigInt(eth.unitScale), ops.ETH_UNIT_SCALE);
  assert.equal(CONFIDENTIAL_DEPLOYMENTS.mainnet.pool.toLowerCase(), ops.POOL.toLowerCase());
});

test('attest calldata: attestBitcoinStateProven(publicValues, proof), as cast encodes it', () => {
  // cast calldata "attestBitcoinStateProven(bytes,bytes)" 0xabcd 0x0102030405
  const want = '0x0b36171c' + word(0x40) + word(0x80) + word(2) + 'abcd'.padEnd(64, '0') + word(5) + '0102030405'.padEnd(64, '0');
  assert.equal(ops.encodeAttest('0xabcd', '0x0102030405'), want);
  const full = ops.encodeAttest('0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(64));
  assert.equal(full, '0x0b36171c' + word(0x40) + word(0x80) + word(32) + 'ab'.repeat(32) + word(64) + 'cd'.repeat(64));
});

test('a published proof is offered only while it builds on the pool’s digest', () => {
  const D = '0x' + 'aa'.repeat(32);
  const rec = { priorDigest: D, newDigest: '0x' + 'bb'.repeat(32), attestedTo: 973100, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(32), at: 1 };
  assert.equal(ops.attestOffer(null, D), 'none');
  assert.equal(ops.attestOffer(rec, D), 'ready');
  assert.equal(ops.attestOffer(rec, D.toUpperCase().replace('0X', '0x')), 'ready', 'case does not matter');
  assert.equal(ops.attestOffer(rec, '0x' + '99'.repeat(32)), 'spent');
  assert.equal(ops.attestOffer({ ...rec, proof: '0xabc' }, D), 'malformed', 'odd-length hex');
  assert.equal(ops.attestOffer({ ...rec, priorDigest: '0x1234' }, D), 'malformed');
  assert.equal(ops.attestOffer({ ...rec, publicValues: undefined }, D), 'malformed');
});

test('readProof reads the published proof and the pool’s digest together', async () => {
  const D = '0x' + 'AA'.repeat(32);
  const rec = { priorDigest: D.toLowerCase(), newDigest: '0x' + 'bb'.repeat(32), attestedTo: 9, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(32), at: 1 };
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return { ok: true, json: async () => ({ ok: true, proof: rec }) }; };
  const call = async (to, data) => { asked.push([to, data]); return D; };
  const r = await ops.readProof({ api: 'https://api.example/', call, fetchImpl });
  assert.deepEqual(r, { rec, digest: D.toLowerCase(), offer: 'ready' });
  assert.deepEqual(asked, ['https://api.example/reflection/proof?network=mainnet', [ops.POOL, ops.SEL_ATTESTED_DIGEST]]);
  const none = await ops.readProof({ api: 'https://api.example', call, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, proof: null }) }) });
  assert.equal(none.offer, 'none');
  await assert.rejects(ops.readProof({ api: 'x', call, fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
});

test('the pool’s refusals of an attest read in words, and a lane far behind needs the checkpoint', () => {
  assert.equal(ops.attestRefusal('execution reverted 0xe677decb'), 'the pool has already moved past this batch');
  assert.equal(ops.attestRefusal('execution reverted 0xD3897419'), 'the header relay has not confirmed this batch yet');
  assert.equal(ops.attestRefusal('execution reverted 0x12345678'), null);
  assert.equal(ops.needsAncestry(null), false);
  assert.equal(ops.needsAncestry(2016), false);
  assert.equal(ops.needsAncestry(2017), true);
  assert.equal(ops.ancestryCalls(2017), 1);
  assert.equal(ops.ancestryCalls(4032), 1);
  assert.equal(ops.ancestryCalls(4033), 2);
  assert.equal(ops.ancestryCalls(970100 - 24 - 960000), 4, 'the keeper page check’s gap');
});

test('what a real settle pays its sender, and its settle re-encoded byte for byte', () => {
  assert.equal(ops.ethFeeWei(real.publicValues), 41000n * ops.ETH_UNIT_SCALE);
  assert.equal(ops.settleCalldata(real), REAL.toLowerCase());
  assert.equal(ops.settleCalldata(real), workerSettleCalldata(real), 'the same encoding the API checks landings against');
  assert.equal(ops.ethFeeWei(pv({ fees: [[TAC, 5n * 10n ** 8n]] })), 0n, 'a leg in another asset counts nothing');
  assert.equal(ops.ethFeeWei(pv({ fees: [[ETH, 7n], [TAC, 1n], [ETH, 3n]] })), 10n * ops.ETH_UNIT_SCALE, 'tETH legs add up');
  assert.equal(ops.ethFeeWei('0x1234'), 0n, 'unreadable public values pay nothing here');
  assert.equal(ops.expiresAtMs({ publicValues: real.publicValues }), 0);
});

test('a job can be sent while open, whole, and not about to expire', () => {
  const now = 2_000_000_000_000;
  assert.equal(ops.sendable(job(1), { nowMs: now }), true);
  assert.equal(ops.sendable(job(1, { status: 'sending' }), { nowMs: now }), false, 'a sender has taken it');
  assert.equal(ops.sendable({ ...job(1), memos: undefined }, { nowMs: now }), false);
  assert.equal(ops.sendable({ ...job(1), proof: '' }, { nowMs: now }), false);
  assert.equal(ops.sendable(job(1, { expiresAt: now + 60_000 }), { nowMs: now }), false, 'within the two-minute margin');
  assert.equal(ops.sendable(job(1, { expiresAt: now + 600_000 }), { nowMs: now }), true);
  assert.equal(ops.sendable(job(1, { deadline: Math.floor(now / 1000) + 30 }), { nowMs: now }), false, 'the proof’s own deadline when the board gives none');
  assert.equal(ops.expiresAtMs(job(1, { deadline: 1792663800 })), 1792663800000);
});

test('the board in figures', () => {
  const s = ops.boardSummary([job(1, { fee: 300n, feeUsd: 1.5 }), job(2, { fee: 200n, feeUsd: 1 }), job(3, { fee: 900n, status: 'sending', feeUsd: 9 }), job(4, { fee: 5n, asset: TAC, feeUsd: 0.25 })]);
  assert.deepEqual(s, { waiting: 3, feeWei: 500n * ops.ETH_UNIT_SCALE, feeUsd: 2.75 });
  assert.deepEqual(ops.boardSummary([]), { waiting: 0, feeWei: 0n, feeUsd: 0 });
});

test('pickSettle: with a cost, the oldest that pays it with the margin; without, the best payer', () => {
  const cost = 10n ** 14n;                                    // 0.0001 ETH of gas
  const jobs = [
    job(1, { fee: unitsFor(1n * 10n ** 14n), since: 100 }),   // pays exactly its gas: short of a 20% margin
    job(2, { fee: unitsFor(3n * 10n ** 14n), since: 300 }),
    job(3, { fee: unitsFor(2n * 10n ** 14n), since: 200 }),
    job(4, { fee: unitsFor(9n * 10n ** 14n), since: 50, status: 'sending' }),
    job(5, { fee: 0n, since: 10, feeUsd: 3 }),
  ];
  assert.equal(ops.pickSettle(jobs, { costWei: cost, marginBps: 2000n })?.jobId, jobs[2].jobId, 'oldest of those that pay with 20% to spare');
  assert.equal(ops.pickSettle(jobs, { costWei: cost, marginBps: 0n })?.jobId, jobs[0].jobId, 'at no margin the one that just pays is oldest');
  assert.equal(ops.pickSettle(jobs, { costWei: cost, marginBps: 2000n, skip: new Set([jobs[2].jobId]) })?.jobId, jobs[1].jobId, 'a passed-over job is skipped');
  assert.equal(ops.pickSettle(jobs, { costWei: 10n ** 15n, marginBps: 2000n }), null, 'none pays a dear gas price');
  assert.equal(ops.pickSettle(jobs)?.jobId, jobs[1].jobId, 'without a cost: the one paying the most');
  assert.equal(ops.pickSettle([job(5, { feeUsd: 3, since: 9 }), job(6, { feeUsd: 4, since: 10 })])?.jobId, '0x' + word(6), 'then by the board’s USD figure');
  assert.equal(ops.pickSettle([job(7, { fee: 5n, since: 20 }), job(8, { fee: 5n, since: 10 })])?.jobId, '0x' + word(8), 'then the oldest');
  assert.equal(ops.pickSettle([]), null);
  assert.equal(ops.feeCovers(120n, 100n, 2000n), true);
  assert.equal(ops.feeCovers(119n, 100n, 2000n), false);
});

test('pickSettle with a cost picks what the relay’s own open-board pick does for posted proofs', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const nowMs = 2_000_000_000_000;
  for (let round = 0; round < 200; round++) {
    const jobs = Array.from({ length: 1 + rnd(6) }, (_, i) => job(round * 10 + i, {
      fee: BigInt(rnd(5)) * 10_000n, since: rnd(1000), status: rnd(5) ? 'open' : 'sending', expiresAt: rnd(4) ? 0 : nowMs + rnd(300_000), asset: rnd(6) ? ETH : TAC,
    }));
    const costWei = BigInt(rnd(4)) * 10n ** 14n, marginBps = BigInt(rnd(3) * 1000);
    const mine = ops.pickSettle(jobs, { costWei, marginBps, nowMs });
    const relay = pickOpen(jobs.map((j) => ({ ...j, posted: true })), { settleCostWei: costWei, ethAssetId: ETH, ethUnitScale: ops.ETH_UNIT_SCALE, marginBps, nowMs });
    // Two jobs open the same moment with the same fee may come out in either order; the fee and the age must agree.
    assert.equal(mine?.openSince ?? null, relay?.openSince ?? null, `round ${round}`);
  }
});

test('the board read refuses a pool it does not know, and a landing is reported as the API asks', async () => {
  const board = (b) => async () => ({ ok: true, json: async () => b });
  const ok = await ops.readBoard({ api: 'https://api.example', fetchImpl: board({ pool: ops.POOL.toLowerCase(), jobs: [job(1)] }) });
  assert.equal(ok.jobs.length, 1);
  assert.deepEqual(await ops.readBoard({ api: 'https://api.example', fetchImpl: board({ pool: ops.POOL, jobs: null }) }), { pool: ops.POOL, jobs: [] });
  await assert.rejects(ops.readBoard({ api: 'x', fetchImpl: board({ pool: '0x' + '11'.repeat(20), jobs: [job(1)] }) }), /names pool/);
  await assert.rejects(ops.readBoard({ api: 'x', fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);

  const posts = [];
  const r = await ops.reportLanded({
    api: 'https://api.example/', jobId: '0x' + '01'.repeat(32), txHash: '0x' + '02'.repeat(32),
    fetchImpl: async (url, init) => { posts.push([url, init.method, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ ok: true, status: 'settled' }) }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(posts, [['https://api.example/confidential/landed', 'POST', { jobId: '0x' + '01'.repeat(32), txHash: '0x' + '02'.repeat(32) }]]);
  const refused = await ops.reportLanded({ api: 'x', jobId: '0x', txHash: '0x', fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'not settled by that tx' }) }) });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
});

test('ETH figures', () => {
  assert.equal(ops.ethText(0n), '0');
  assert.equal(ops.ethText(5n * 10n ** 13n), '<0.0001');
  assert.equal(ops.ethText(4n * 10n ** 14n), '0.00040');
  assert.equal(ops.ethText(62n * 10n ** 14n), '0.0062');
  assert.equal(ops.ethText(12345n * 10n ** 15n), '12.345');
});

test('the relay sends a posted step the API took on its free settles (a stealth lock, no fee), and no other posted step without its fee', () => {
  const nowMs = 2_000_000_000_000, base = { status: 'open', publicValues: '0x', proof: '0x01', posted: true, openSince: 1, expiresAt: 0 };
  const opts = { settleCostWei: 10n ** 15n, ethAssetId: ETH, ethUnitScale: ops.ETH_UNIT_SCALE, nowMs };
  assert.equal(pickOpen([{ ...base, jobId: 'a', type: 'stealthlock', free: true }], opts)?.jobId, 'a');
  assert.equal(pickOpen([{ ...base, jobId: 'b', type: 'stealthlock' }], opts), null, 'not taken on the free settles: it pays nothing, so it waits');
  assert.equal(pickOpen([{ ...base, jobId: 'c', type: 'transfer' }], opts), null);
});
