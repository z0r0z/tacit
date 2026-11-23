#!/usr/bin/env node
// dapp/vault/feed.js with a vault whose oracle is a TacProvenOracle: the oracle is told apart by `coverage()`, its prices read as up to date while the
// interval that counts is one of the first two its proof holds, one record is missing past them, and that record is the newest posted proof in the
// oracle's `record`, refused unless it covers the interval that counts and is newer than what the oracle holds. No network: a fake node and fake provers.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

const dapp = new URL('../dapp/', import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'vault-feed-proven-'));
const src = readFileSync(new URL('vault/feed.js', dapp), 'utf8')
  .replace(/'\/evm-trade-venues\.js\?cb=[^']*'/, `'${new URL('evm-trade-venues.js', dapp).href}'`)
  .replace(/'\/vendor\/tacit-deps\.min\.js'/, `'${new URL('vendor/tacit-deps.min.js', dapp).href}'`);
writeFileSync(join(tmp, 'feed.mjs'), src);
const Feed = await import(pathToFileURL(join(tmp, 'feed.mjs')).href);

const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const VAULT = `0x${'aa'.repeat(20)}`, ORACLE = `0x${'0b'.repeat(20)}`;
const STEP = 50, GRACE = 30;

// Multicall3's aggregate3 answer: (bool success, bytes returnData)[].
function aggregate(rets) {
  const items = rets.map((r) => { const d = strip(r); return word(1) + word(64) + word(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0'); });
  let head = '', off = rets.length * 32;
  for (const it of items) { head += word(off); off += it.length / 2; }
  return `0x${word(32)}${word(rets.length)}${head}${items.join('')}`;
}

// Multicall3's aggregate3 calls, decoded: [{ to, data }].
function calls(data) {
  const h = strip(data).slice(8);
  const at = (i) => BigInt(`0x${h.slice(i * 2, i * 2 + 64)}`);
  const base = Number(at(0)) + 32, n = Number(at(base - 32));
  return Array.from({ length: n }, (_, i) => {
    const t = base + Number(at(base + 32 * i));
    const b = t + Number(at(t + 64));
    return { to: `0x${h.slice(t * 2 + 24, t * 2 + 64)}`, data: `0x${h.slice(b * 2 + 64, b * 2 + 64 + Number(at(b)) * 2)}` };
  });
}

// A node: the vault's proven oracle (coverage, STEP, GRACE, FALLBACK) and, behind it, `pair` (a function of a call, for the pair's venues).
function node({ head, x, first = x - 1, count = 5, fallback = `0x${'00'.repeat(20)}`, pair = () => null }) {
  const one = (to, data) => {
    const sel = data.slice(0, 10);
    if (to === VAULT && sel === Feed.SEL.ORACLE) return `0x${word(ORACLE)}`;
    if (to === ORACLE && sel === Feed.SEL.coverage) return `0x${word(x)}${word(first)}${word(count)}`;
    if (to === ORACLE && sel === Feed.SEL.STEP) return `0x${word(STEP)}`;
    if (to === ORACLE && sel === Feed.SEL.GRACE) return `0x${word(GRACE)}`;
    if (to === ORACLE && sel === Feed.SEL.FALLBACK) return `0x${word(fallback)}`;
    const r = pair(to, data);
    if (r != null) return r;
    throw new Error(`unexpected call ${to} ${sel}`);
  };
  return async (method, params) => {
    if (method === 'eth_blockNumber') return `0x${head.toString(16)}`;
    assert.equal(method, 'eth_call');
    const { to, data } = params[0];
    if (to.toLowerCase() === Feed.MULTICALL3.toLowerCase()) return aggregate(calls(data).map((c) => one(c.to, c.data)));
    return one(to, data);
  };
}

// A proof as tac-oracle-host posts it: X in the low bits of the second word, the anchor at bit 168.
const posted = (x, anchor = (x + 1) * STEP + 3) => ({
  publicValues: `0x${'11'.repeat(32)}${word((BigInt(anchor) << 168n) | (5n << 64n) | (BigInt(x - 1) << 32n) | BigInt(x))}${'22'.repeat(32 * 5)}`,
  proof: `0x${'33'.repeat(288)}`,
});
const prover = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });

// The block at which N is the newest interval that counts.
const at = (n) => (n + 2) * STEP + GRACE;

{
  const x = 528_000;
  const feed = Feed.makeFeed({ rpc: node({ head: at(x), x }) });
  const st = await feed.read(VAULT);
  assert.equal(st.proven, true);
  assert.equal(st.ready, true);
  assert.equal(st.missing, 0);
  assert.deepEqual(feed.nextBatch(st), []);
  ok('a proven oracle whose proof holds the interval that counts reads as up to date');
}

{
  const x = 528_000;
  // X + 1 counts: the depth is held for X - 1 and X only, so one proof is missing.
  const head = at(x + 1);
  const feed = Feed.makeFeed({ rpc: node({ head, x }), proofUrls: ['https://a', 'https://b'], fetchImpl: async (url) => (url === 'https://a' ? prover(null, 503)() : prover(posted(x + 2))()) });
  const st = await feed.read(VAULT);
  assert.equal(st.ready, false);
  assert.equal(st.missing, 1);
  const part = feed.nextBatch(st);
  assert.equal(part.length, 1);
  const [v, k] = part[0];
  assert.equal(v.oracle, ORACLE);
  assert.equal(k, Math.floor((head - 1) / STEP) - 1, 'the newest interval whose following block exists');
  const [rec] = await feed.build(part);
  const p = posted(x + 2);
  assert.equal(rec.to, ORACLE);
  assert.equal(rec.k, k, 'the record answers the plan it was built for');
  assert.equal(rec.n, (x + 3) * STEP + 3, 'the anchor');
  assert.equal(rec.data, Feed.encRecord([p.publicValues, p.proof, [], [], []]));
  assert.equal(rec.data.slice(0, 10), '0x3113428b', 'the venue oracles\' record selector, which the router forwards');
  ok('past the first two intervals one proof is missing, and the newest posted proof is that record (a prover that fails is passed over)');
}

{
  const x = 528_000;
  const head = at(x + 1);
  const stale = Feed.makeFeed({ rpc: node({ head, x }), proofUrls: ['https://a'], fetchImpl: prover(posted(x)) });
  const st = await stale.read(VAULT);
  await assert.rejects(stale.build(stale.nextBatch(st)), /not newer/);
  const none = Feed.makeFeed({ rpc: node({ head, x }) });
  await assert.rejects(none.build(none.nextBatch(await none.read(VAULT))), /No proof of the newest prices/);
  const junk = Feed.makeFeed({ rpc: node({ head, x }), proofUrls: ['https://a'], fetchImpl: prover({ publicValues: '0x12', proof: '0x34' }) });
  await assert.rejects(junk.build(junk.nextBatch(await junk.read(VAULT))), /sent no proof/);
  ok('a proof no newer than the oracle\'s, no prover, or a reply that is not a proof gives no record');
}

// ── no proof posted: the pair behind the oracle is recorded as before, through the oracle ──
{
  const FX = JSON.parse(readFileSync(new URL('fixtures/vault-feed-blocks.json', import.meta.url), 'utf8'));
  const K = FX.k, hex = (v) => `0x${v.toString(16)}`;
  assert.equal(FX.step, STEP);
  const BLOCKS = { [hex(Number(FX.next.number))]: FX.next, [hex(Number(FX.sample.number))]: FX.sample };
  const PROOF = { accountProof: ['0x1234', '0x5678'], storageProof: [{ proof: ['0xaa'] }, { proof: ['0xbb', '0xcc'] }] };
  const PAIR = `0x${'c1'.repeat(20)}`, VA = `0x${'a1'.repeat(20)}`, VB = `0x${'a2'.repeat(20)}`;
  const SLOTS = `0x${word(0)}${word(5)}`;
  // Every interval of both venues recorded but K on venue A.
  const pair = (to, data) => {
    const sel = data.slice(0, 10);
    if (to === PAIR && sel === Feed.SEL.A) return `0x${word(VA)}`;
    if (to === PAIR && sel === Feed.SEL.B) return `0x${word(VB)}`;
    if (to !== VA && to !== VB) return null;
    if (sel === Feed.SEL.STEP) return `0x${word(STEP)}`;
    if (sel === Feed.SEL.MAX_WINDOW) return `0x${word(28_800)}`;
    if (sel === Feed.SEL.POOL) return `0x${word(`0x${'b0'.repeat(20)}`)}`;
    if (sel === Feed.SEL.slots) return SLOTS;
    if (sel === Feed.SEL.sampleOf) return BigInt(`0x${data.slice(10)}`) === BigInt(K) && to === VA ? `0x${word(0)}${word(0)}` : `0x${word(10n ** 14n)}${word(10n ** 19n)}`;
    return null;
  };
  const head = (K + 2) * STEP + 11;
  const feed = Feed.makeFeed({
    rpc: node({ head, x: K - 5, fallback: PAIR, pair }),
    headerRpc: async (m, [num]) => BLOCKS[num],
    proofRpc: async () => PROOF,
  });
  const st = await feed.read(VAULT);
  assert.equal(st.ready, false);
  assert.equal(st.missing, 1);
  assert.deepEqual(st.venues.map((v) => [v.oracle, v.relay, v.tag]), [[VA, ORACLE, 0], [VB, ORACLE, 1]]);
  const part = feed.nextBatch(st);
  assert.deepEqual(part.map(([v, k]) => [v.oracle, k]), [[VA, K]]);
  const [rec] = await feed.build(part);
  assert.equal(rec.to, ORACLE, 'sent through the proven oracle, which the router accepts as the vault\'s venue');
  assert.equal(rec.venue, VA, 'and names the venue it is for');
  assert.equal(rec.k, K);
  const want = Feed.encRecord([Feed.headerRlp(FX.sample), Feed.headerRlp(FX.next), PROOF.accountProof, PROOF.storageProof[0].proof, [...PROOF.storageProof[1].proof, '0x00']]);
  assert.equal(rec.data, want, 'the venue oracle\'s own record, with venue A\'s tag last in proofB');
  ok('with no newer proof the pair\'s venues are what is missing, each record sent through the proven oracle with its venue\'s tag');
}

console.log(`vault-feed-proven: ${n} ok`);
