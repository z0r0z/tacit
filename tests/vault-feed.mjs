#!/usr/bin/env node
// dapp/vault/feed.js without a network: the record the price feed builds for an interval from a node's headers and proofs, a header believed only when it
// rebuilds to its own hash, the two venues of an interval asking for each block once, and the pool of nodes passing over one that sends a wrong header or proof.
// The two headers are real mainnet blocks (tests/fixtures/vault-feed-blocks.json): the block that follows an interval and the one its mixHash picks.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

// The modules import their helpers by address on the site; here they are the same files by path.
const dapp = new URL('../dapp/', import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'vault-feed-'));
const copy = (name) => {
  const src = readFileSync(new URL(`vault/${name}.js`, dapp), 'utf8')
    .replace(/'\/evm-trade-venues\.js\?cb=[^']*'/, `'${new URL('evm-trade-venues.js', dapp).href}'`)
    .replace(/'\/vendor\/tacit-deps\.min\.js'/, `'${new URL('vendor/tacit-deps.min.js', dapp).href}'`)
    .replace(/'\.\.\/rpc-body\.js'/, `'${new URL('rpc-body.js', dapp).href}'`);
  writeFileSync(join(tmp, `${name}.mjs`), src);
  return import(pathToFileURL(join(tmp, `${name}.mjs`)).href);
};
const Feed = await copy('feed'), Chain = await copy('chain');

const FX = JSON.parse(readFileSync(new URL('fixtures/vault-feed-blocks.json', import.meta.url), 'utf8'));
const hex = (x) => `0x${x.toString(16)}`;
const NEXT = Number(FX.next.number), SAMPLE = Number(FX.sample.number), K = FX.k;
assert.equal(NEXT, (K + 1) * FX.step);
assert.equal(SAMPLE, K * FX.step + Number(BigInt(FX.next.mixHash) % BigInt(FX.step)), 'the fixture is the interval\'s own pair of blocks');
const BLOCKS = { [hex(NEXT)]: FX.next, [hex(SAMPLE)]: FX.sample };
const slot = (b) => `0x${b.repeat(32)}`;
const venue = (a, b) => ({ oracle: `0x${a.repeat(20)}`, step: FX.step, pool: `0x${b.repeat(20)}`, slots: [slot('00'), slot('11')] });
const V1 = venue('a1', 'b1'), V2 = venue('a2', 'b2');
const PROOF = { accountProof: ['0x1234', '0x5678'], storageProof: [{ proof: ['0xaa'] }, { proof: ['0xbb', '0xcc'] }] };

// ── the record, and each block asked for once ──
{
  const headers = [], proofs = [];
  const headerRpc = async (m, [num]) => { headers.push(num); return BLOCKS[num]; };
  const proofRpc = async (m, [pool, slots, num]) => { proofs.push([pool, num]); return PROOF; };
  const feed = Feed.makeFeed({ rpc: null, headerRpc, proofRpc });
  const recs = await feed.build([[V1, K], [V2, K]]);
  assert.deepEqual(headers.slice().sort(), [hex(NEXT), hex(SAMPLE)].sort(), 'the two venues share their blocks: each is asked for once');
  assert.deepEqual(proofs.map((p) => p[0]).sort(), [V1.pool, V2.pool].sort());
  assert.ok(proofs.every((p) => p[1] === hex(SAMPLE)), 'and the proofs are at the block the next block\'s mixHash picked');
  assert.deepEqual(recs.map((r) => [r.to, r.k, r.n]), [[V1.oracle, K, SAMPLE], [V2.oracle, K, SAMPLE]]);
  assert.ok(recs.every((r) => r.data.startsWith(Feed.SEL.record)), 'each is a call of record(…)');
  assert.ok(recs[0].data.includes(Feed.headerRlp(FX.sample).slice(2)) && recs[0].data.includes(Feed.headerRlp(FX.next).slice(2)), 'with both headers rebuilt by the page');
  ok('a record carries both headers and the proofs, and the two venues of an interval ask for each block once');
}

// ── a header is believed only when it rebuilds to its own hash ──
{
  const forged = { ...FX.sample, stateRoot: `0x${'ab'.repeat(32)}` };
  assert.throws(() => Feed.headerRlp(forged), /did not rebuild/);
  const feed = Feed.makeFeed({ rpc: null, headerRpc: async (m, [num]) => (num === hex(SAMPLE) ? forged : BLOCKS[num]), proofRpc: async () => PROOF });
  await assert.rejects(feed.build([[V1, K]]), /did not rebuild/);
  ok('a header that does not rebuild to its hash is refused');
}

// ── a Glamsterdam header (a real Sepolia block): its block access list hash and slot number follow requestsHash ──
{
  const GX = JSON.parse(readFileSync(new URL('fixtures/vault-feed-glamsterdam-block.json', import.meta.url), 'utf8')).block;
  assert.ok(Feed.headerRlp(GX).includes(GX.blockAccessListHash.slice(2)), 'it rebuilds to its hash, with the block access list hash in it');
  assert.throws(() => Feed.headerRlp({ ...GX, slotNumber: undefined }), /did not rebuild/, 'and without its slot number it does not');
  const nulls = { ...FX.sample, blockAccessListHash: null, slotNumber: null };
  assert.equal(Feed.headerRlp(nulls), Feed.headerRlp(FX.sample), 'an older block a node writes the new fields as null for rebuilds as before');
  ok('a Glamsterdam header rebuilds to its hash, and an older one as before');
}

// ── the pool passes over a node with a wrong header or proof ──
{
  const forged = { ...FX.sample, stateRoot: `0x${'ab'.repeat(32)}` };
  const seen = [];
  const reply = (host) => async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    seen.push([new URL(url).host, method]);
    const body = host === 'bad.test'
      ? (method === 'eth_getBlockByNumber' ? (params[0] === hex(SAMPLE) ? forged : BLOCKS[params[0]]) : { accountProof: [], storageProof: [] })
      : (method === 'eth_getBlockByNumber' ? BLOCKS[params[0]] : PROOF);
    return { status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: body }) };
  };
  const fetchImpl = (url, init) => reply(new URL(url).host)(url, init);
  const pool = Chain.makeRpc(['https://bad.test', 'https://good.test'], { fetchImpl });
  const feed = Feed.makeFeed({ rpc: pool, headerRpc: pool, proofRpc: pool });
  const recs = await feed.build([[V1, K], [V2, K]]);
  assert.equal(recs.length, 2);
  assert.ok(seen.some(([h, m]) => h === 'good.test' && m === 'eth_getProof'), 'the proof came from the node that sent a whole one');
  const badProofs = () => seen.filter(([h, m]) => h === 'bad.test' && m === 'eth_getProof').length;
  const asked = badProofs();
  assert.ok(asked >= 1 && asked <= 2, 'the node that sent an empty proof was asked only by the calls already in flight');
  await feed.build([[V1, K]]);
  assert.equal(badProofs(), asked, 'and is not asked for a proof again while it rests');
  assert.ok(recs.every((r) => r.data.includes(Feed.headerRlp(FX.sample).slice(2))), 'every record carries the real header, not the forged one');
  ok('a node that sends a header that does not rebuild, or a proof with nothing in it, is passed over for the next');
}

// ── a record built again leaves out the nodes first in line ──
{
  const asked = [];
  const rpc = async (m, p, o = {}) => { asked.push([m, o.skip]); return m === 'eth_getProof' ? PROOF : BLOCKS[p[0]]; };
  const feed = Feed.makeFeed({ rpc: null, headerRpc: rpc, proofRpc: rpc });
  await feed.buildRecord(V1, K);
  await feed.buildRecord(V1, K, undefined, 2);
  assert.ok(asked.slice(0, 3).every(([, s]) => !s) && asked.slice(3).every(([, s]) => s === 2), 'skip reaches every header and proof call');
  ok('building a record again passes skip to the pool for the headers and the proof');
}

console.log(`${n} checks passed`);
