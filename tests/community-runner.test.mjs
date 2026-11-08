// tools/community-runner.mjs: its configuration, when each mode acts on what it reads, the key it signs with, and whole passes against
// a stubbed chain, API and explorer (a dry run sends nothing; a live pass simulates, signs, sends one transaction and reports a landing).
// The same passes against real contracts on a mainnet fork: tests/community-runner-fork.mjs.
//
// Run: node --test tests/community-runner.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { readConfig, headersVerdict, attestVerdict, gasAllows, makeSigner, makeRunner, MODES } from '../tools/community-runner.mjs';
import { POOL, ETH_ASSET_ID, ETH_UNIT_SCALE, SEL_ATTEST, SEL_ATTESTED_DIGEST, TAC_ASSET_ID } from '../dapp/community-ops.js';
import { makePost } from '../dapp/nostr-board.js';

const ANVIL0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);
const keccakHex = (h) => '0x' + Buffer.from(keccak_256(Buffer.from(h.slice(2), 'hex'))).toString('hex');

test('configuration: modes, defaults, and what is refused', () => {
  const c = readConfig({ RUNNER_KEY: ANVIL0 }, []);
  assert.deepEqual(c.modes, MODES);
  assert.equal(c.dryRun, false);
  assert.equal(c.rpcUrl, 'https://ethereum-rpc.publicnode.com');
  assert.equal(c.sendRpcUrl, 'https://rpc.flashbots.net/fast?hint=hash');
  assert.equal(c.api, 'https://api.tacit.finance');
  assert.deepEqual(c.secs, { headers: 300, attest: 60, settles: 15, board: 5, mirror: 60 });
  assert.throws(() => readConfig({ DRY_RUN: '1' }, ['prove']), /unknown mode/, 'the proof market is gone: prove is no mode');
  assert.equal(c.marginBps, 2000n);
  assert.equal(c.maxGasWei, 5n * 10n ** 9n);
  assert.equal(c.priorityWei, 10n ** 8n);
  assert.equal(c.attestAfterMs, 120_000);
  assert.deepEqual(readConfig({ RUNNER_KEY: ANVIL0 }, ['settles']).modes, ['settles']);
  assert.deepEqual(readConfig({ RUNNER_KEY: ANVIL0, MODE: 'Headers' }, []).modes, ['headers']);
  assert.equal(readConfig({ DRY_RUN: '1' }, []).key, null, 'a dry run needs no key');
  assert.equal(readConfig({ DRY_RUN: '1', MAX_GAS_GWEI: '0', API_BASE: 'http://x/' }, []).maxGasWei, 0n);
  assert.equal(readConfig({ DRY_RUN: '1', API_BASE: 'http://x/' }, []).api, 'http://x');
  assert.equal(readConfig({ DRY_RUN: '1', HEADERS_NEED: '973200' }, []).headersNeed, 973200);
  assert.throws(() => readConfig({}, []), /RUNNER_KEY/);
  assert.throws(() => readConfig({ DRY_RUN: '1' }, ['drains']), /unknown mode/);
  assert.throws(() => readConfig({ DRY_RUN: '1', HEADERS_NEED: 'tip' }, []), /HEADERS_NEED/);
  assert.throws(() => readConfig({ DRY_RUN: '1', MARGIN_BPS: '-1' }, []), /MARGIN_BPS/);
});

test('headers go out when the next proof waits on the relay and it has fallen behind, or for a named height', () => {
  const st = { relayTip: 1000, btcTip: 1010, attested: 976, confirmations: 24 };
  const go = { action: 'advance', from: 1001, to: 1008, pending: 8, useless: false };
  assert.deepEqual(headersVerdict(st, go, { minBehind: 3 }).go, true);
  assert.equal(headersVerdict({ ...st, btcTip: 1004 }, { ...go, to: 1002, pending: 2 }, { minBehind: 3 }).go, false, 'two behind: left to Tacit’s relay');
  assert.match(headersVerdict({ ...st, btcTip: 1004 }, { ...go, to: 1002, pending: 2 }, { minBehind: 3 }).why, /HEADERS_MIN_BEHIND=3/);
  assert.equal(headersVerdict({ ...st, attested: 900 }, { ...go, useless: true }, { minBehind: 3 }).go, false, 'the relay already leads the proofs');
  assert.equal(headersVerdict(st, { action: 'idle', pending: 0, useless: false }).go, false);
  assert.equal(headersVerdict(st, { ...go, useless: true }, { minBehind: 99, need: 1005 }).go, true, 'a named height is carried whatever the pacing');
  assert.match(headersVerdict(st, { action: 'idle', pending: 0, useless: true }, { need: 990 }).why, /already has block 990/);
  assert.equal(gasAllows(5n * 10n ** 9n, 5n * 10n ** 9n), true);
  assert.equal(gasAllows(5n * 10n ** 9n + 1n, 5n * 10n ** 9n), false);
  assert.equal(gasAllows(10n ** 12n, 0n), true, 'no ceiling');
});

test('an attest is sent once Tacit’s prover has had its time to land the proof', () => {
  const rec = { attestedTo: 973100, at: 1_000_000 };
  assert.equal(attestVerdict({ rec: null, offer: 'none' }).go, false);
  assert.equal(attestVerdict({ rec, offer: 'spent' }).go, false);
  assert.equal(attestVerdict({ rec, offer: 'malformed' }).go, false);
  assert.equal(attestVerdict({ rec, offer: 'ready' }, { nowMs: 1_000_000 + 60_000, afterMs: 120_000 }).go, false);
  assert.match(attestVerdict({ rec, offer: 'ready' }, { nowMs: 1_000_000 + 60_000, afterMs: 120_000 }).why, /published 60 s ago/);
  assert.equal(attestVerdict({ rec, offer: 'ready' }, { nowMs: 1_000_000 + 120_000, afterMs: 120_000 }).go, true);
  assert.equal(attestVerdict({ rec: { attestedTo: 1 }, offer: 'ready' }, { nowMs: 5, afterMs: 120_000 }).go, true, 'a proof with no publication time is not held back');
});

test('the key: its address, and a signed type-2 transaction whose hash is the keccak of its bytes', () => {
  const s = makeSigner(ANVIL0);
  assert.equal(s.address, '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  assert.equal(makeSigner(ANVIL0.slice(2)).address, s.address, 'with or without 0x');
  const tx = s.sign({ chainId: 1n, nonce: 7n, maxPriorityFeePerGas: 10n ** 8n, maxFeePerGas: 3n * 10n ** 9n, gasLimit: 100000n, to: POOL, value: 0n, data: '0xaa9e6609' });
  assert.match(tx.raw, /^0x02f8/);
  assert.equal(tx.hash, keccakHex(tx.raw));
  assert.ok(tx.raw.includes(POOL.slice(2).toLowerCase()) && tx.raw.includes('aa9e6609'), 'it carries the call');
  assert.throws(() => makeSigner('0x1234'), /32 bytes/);
});

// ── whole passes against stubs ──
// A PublicValues encoding with one tETH fee leg of `wei`.
function pv(wei) {
  const head = Array.from({ length: 19 }, () => word(0));
  head[7] = word(19 * 32);
  return '0x' + word(32) + head.join('') + word(1) + ETH_ASSET_ID.slice(2) + word(wei / ETH_UNIT_SCALE);
}
function world({ board = [], proof = null, digest = '0x' + 'aa'.repeat(32), baseFee = 10n ** 9n, refuse = null, apiDown = false, tacPool = null } = {}) {
  const seen = { rpc: [], sent: [], landed: [], gets: [] };
  const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => String(b) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'rpc.test' || u.host === 'send.test') {
      const { method, params } = JSON.parse(init.body);
      seen.rpc.push(method);
      const r = (result) => json({ jsonrpc: '2.0', id: 1, result });
      if (method === 'eth_sendRawTransaction') { seen.sent.push(params[0]); return r(keccakHex(params[0])); }
      if (method === 'eth_chainId') return r('0x1');
      if (method === 'eth_getBalance') return r(hex(10n ** 18n));
      if (method === 'eth_getCode') return r('0x');
      if (method === 'eth_getBlockByNumber') return r({ baseFeePerGas: hex(baseFee), timestamp: hex(Math.floor(Date.now() / 1000)) });
      if (method === 'eth_getTransactionCount') return r('0x5');
      if (method === 'eth_getTransactionReceipt') return r({ status: '0x1', blockNumber: '0x10' });
      if (method === 'eth_gasPrice') return r(hex(baseFee));
      if (method === 'eth_estimateGas') return r(hex(400_000));
      if (method === 'eth_call') {
        const { data, from } = params[0];
        if (data === SEL_ATTESTED_DIGEST) return r(digest);
        if (tacPool && data.startsWith('0xb5217bb4')) return r(tacPool);                // pools(bytes32): the TAC/tETH pool
        if (data === '0x1fd4827a') return r('0x' + word(1000));                 // tipHeight()
        if (data === '0x2755cd2d') return r('0x' + '11'.repeat(32));            // tip()
        if (from && refuse && data.startsWith(refuse)) return json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0xe677decb' } });
        return r('0x');
      }
      throw new Error('unstubbed ' + method);
    }
    seen.gets.push(u.pathname);
    if (u.pathname === '/confidential/open') return apiDown ? json({ error: 'down' }, 502) : json({ pool: POOL, jobs: board });
    if (u.pathname === '/confidential/landed') { seen.landed.push(JSON.parse(init.body)); return json({ ok: true, status: 'settled' }); }
    if (u.pathname === '/reflection/proof') return json({ ok: true, proof });
    if (u.pathname === '/reflection/status') return json({ attestedHeight: 976, confirmations: 24 });
    if (u.pathname === '/api/blocks/tip/height') return json(1002);
    if (u.pathname === '/api/block-height/1000') return json('11'.repeat(32));
    throw new Error('unstubbed ' + url);
  };
  return { fetchImpl, seen };
}
const cfgOf = (env) => readConfig({ RPC_URL: 'http://rpc.test', SEND_RPC_URL: 'http://send.test', API_BASE: 'http://api.test', ESPLORA_URL: 'http://btc.test/api', ONCE: '1', NOSTR: '0', ...env }, []);
const boardJob = (wei, id = 1) => ({ jobId: '0x' + word(id), type: 'transfer', status: 'open', publicValues: pv(wei), proof: '0x' + 'cd'.repeat(260), memos: ['0x' + 'ee'.repeat(40)], openSince: 1, expiresAt: 0 });
const quiet = (lines) => (...a) => lines.push(a.join(' '));

test('a dry run simulates what it would send and sends nothing', async () => {
  const proof = { priorDigest: '0x' + 'aa'.repeat(32), newDigest: '0x' + 'bb'.repeat(32), attestedTo: 980, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(64), at: Date.now() - 10 * 60_000 };
  const { fetchImpl, seen } = world({ board: [boardJob(10n ** 15n)], proof });
  const lines = [];
  const r = makeRunner(cfgOf({ DRY_RUN: '1' }), { fetchImpl, log: quiet(lines) });
  await r.start();
  assert.equal(await r.passes.settles(), false);
  assert.equal(await r.passes.attest(), false);
  assert.equal(seen.sent.length, 0, 'nothing signed or sent');
  assert.equal(seen.landed.length, 0);
  assert.ok(lines.some((l) => /DRY_RUN would send settle 0x00000000 to 0x000000000Ed1eabD231Be41d93b719056F7febFC/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /DRY_RUN would send attestBitcoinStateProven/.test(l)), lines.join('\n'));
  assert.ok(seen.rpc.filter((m) => m === 'eth_estimateGas').length >= 2, 'each was simulated first');
});

test('a live settles pass sends the job that pays, from the runner’s key, and reports it landed', async () => {
  const { fetchImpl, seen } = world({ board: [boardJob(10n ** 14n, 1), boardJob(2n * 10n ** 15n, 2)] });
  const lines = [];
  const r = makeRunner(cfgOf({ RUNNER_KEY: ANVIL0 }), { fetchImpl, log: quiet(lines) });
  assert.equal(await r.passes.settles(), true);
  assert.equal(seen.sent.length, 1, 'one transaction');
  const hash = keccakHex(seen.sent[0]);
  assert.deepEqual(seen.landed, [{ jobId: '0x' + word(2), txHash: hash }], 'the job that pays its 400k gas at 1.1 gwei with 20% to spare, reported by its hash');
  assert.ok(seen.sent[0].includes('717fd7f2'), 'a settle()');
  assert.ok(lines.some((l) => /landed in block 16, 0\.0020 ETH of fees to 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266/.test(l)), lines.join('\n'));
});

test('a settle the pool refuses is passed over, and an attest it refuses is not sent', async () => {
  const proof = { priorDigest: '0x' + 'aa'.repeat(32), newDigest: '0x' + 'bb'.repeat(32), attestedTo: 980, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(64), at: 0 };
  for (const refuse of ['0x717fd7f2', SEL_ATTEST]) {
    const { fetchImpl, seen } = world({ board: [boardJob(2n * 10n ** 15n)], proof, refuse });
    const lines = [];
    const r = makeRunner(cfgOf({ RUNNER_KEY: ANVIL0 }), { fetchImpl, log: quiet(lines) });
    await r.passes[refuse === SEL_ATTEST ? 'attest' : 'settles']();
    assert.equal(seen.sent.length, 0, `${refuse}: nothing sent`);
    if (refuse === SEL_ATTEST) assert.ok(lines.some((l) => /the pool has already moved past this batch/.test(l)), lines.join('\n'));
    else {
      assert.ok(lines.some((l) => /would not take it now/.test(l)), lines.join('\n'));
      assert.equal(await r.passes.settles(), false, 'the next pass passes over it');
      assert.equal(seen.sent.length, 0);
    }
  }
});

test('the unpaid modes wait for gas under the ceiling; a settle is priced by its fee instead', async () => {
  const proof = { priorDigest: '0x' + 'aa'.repeat(32), newDigest: '0x' + 'bb'.repeat(32), attestedTo: 980, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(64), at: 0 };
  const { fetchImpl, seen } = world({ board: [boardJob(2n * 10n ** 16n)], proof, baseFee: 20n * 10n ** 9n });
  const lines = [];
  const r = makeRunner(cfgOf({ RUNNER_KEY: ANVIL0 }), { fetchImpl, log: quiet(lines) });
  assert.equal(await r.passes.attest(), false);
  assert.ok(lines.some((l) => /above MAX_GAS_GWEI=5\.000: waiting/.test(l)), lines.join('\n'));
  assert.equal(seen.sent.length, 0);
  assert.equal(await r.passes.settles(), true, '0.02 ETH pays 400k gas at 20 gwei with the margin');
  assert.equal(seen.sent.length, 1);
});

test('board: races the prover board\'s public jobs with the tacit-prover beside it and hands the proof back under the miner\'s address; a job due before this machine could prove it is passed over', async () => {
  const MINER = '0x' + 'ab'.repeat(20);
  const cfg = readConfig({ MINER, API_BASE: 'https://api.example', DEVICE_PROVER: 'http://prover.local' }, ['board']);
  assert.deepEqual(cfg.modes, ['board']);
  assert.throws(() => readConfig({}, ['board']), /MINER/, 'a board run names the address the board credits');
  const posted = [];
  let jobs = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const reply = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.example/prover/community/claim') return reply(jobs.length ? { job: jobs.shift() } : {});
    if (url === 'https://api.example/prover/community/result') { posted.push(body); return reply({ ok: true, status: body.error ? 'dropped' : 'candidate' }); }
    if (url === 'http://prover.local/prove') { assert.equal(body.stdin, '0x' + Buffer.from('program input').toString('hex'), 'the board\'s base64 input goes to the prover as hex'); return reply({ id: 'j1' }); }
    if (url.startsWith('http://prover.local/job')) return reply({ status: 'done', publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) });
    throw new Error(`unexpected ${url}`);
  };
  const r = makeRunner(cfg, { fetchImpl, log: () => {} });
  assert.equal(await r.passes.board(), false, 'nothing on the board: nothing done');
  const stdin = Buffer.from('program input').toString('base64');
  jobs = [{ jobId: '0xjob1', stdin, deadline: Math.floor(Date.now() / 1000) + 300, label: 'wrapswap', race: true }];
  assert.equal(await r.passes.board(), true);
  assert.deepEqual(posted[0], { miner: MINER, jobId: '0xjob1', publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) });
  // its last proof took a couple of seconds: a job due in one second is passed over, and said so
  jobs = [{ jobId: '0xjob2', stdin, deadline: Math.floor(Date.now() / 1000) + 1, label: 'wrap', race: true }];
  assert.equal(await r.passes.board(), false);
  assert.deepEqual(posted[1], { miner: MINER, jobId: '0xjob2', error: 'too slow for its deadline' });
});

// The board on Nostr (dapp/nostr-board.js), its relays stood in here: what is posted is kept and read back.
function relays() {
  const store = [];
  class WS {
    constructor(url) { this.url = url; setTimeout(() => this.onopen?.(), 0); }
    send(m) {
      const x = JSON.parse(m), out = (v) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(v) }), 0);
      if (x[0] === 'EVENT') { store.push(x[1]); out(['OK', x[1].id, true, '']); }
      if (x[0] === 'REQ') { for (const e of store) out(['EVENT', x[1], e]); out(['EOSE', x[1]]); }
    }
    close() {}
  }
  return { WS, store };
}

test('settles: with the API down, a proof posted on Nostr is sent, and no landing is reported to the API', async () => {
  const { WS, store } = relays();
  store.push(makePost(boardJob(2n * 10n ** 15n, 7), { pool: POOL }));
  const { fetchImpl, seen } = world({ apiDown: true });
  const lines = [];
  const r = makeRunner(cfgOf({ RUNNER_KEY: ANVIL0, NOSTR: '1', NOSTR_RELAYS: 'wss://a.test' }), { fetchImpl, WS, log: quiet(lines) });
  assert.equal(await r.passes.settles(), true);
  assert.equal(seen.sent.length, 1, 'sent');
  assert.equal(seen.landed.length, 0, 'the API is not told: the chain is the record');
  assert.ok(lines.some((l) => /read from Nostr/.test(l)), lines.join('\n'));
});

test('mirror: the API\'s open job no relay carries is posted once, with no key', async () => {
  const { WS, store } = relays();
  const { fetchImpl } = world({ board: [boardJob(10n ** 15n, 3)] });
  const cfg = readConfig({ RPC_URL: 'http://rpc.test', API_BASE: 'http://api.test', ONCE: '1', NOSTR: '1', NOSTR_RELAYS: 'wss://a.test,wss://b.test' }, ['mirror']);
  const r = makeRunner(cfg, { fetchImpl, WS, log: () => {} });
  await r.passes.mirror();
  await r.passes.mirror();
  assert.equal(store.length, 2, 'one post, to each of the two relays');
  assert.equal(JSON.parse(store[0].content).type, 'transfer');
  assert.throws(() => readConfig({ ONCE: '1' }, ['settles']), /RUNNER_KEY/);
  assert.equal(readConfig({ ONCE: '1' }, ['mirror']).modes[0], 'mirror', 'mirror needs no key');
});

test('settles: a TAC fee counts at the TAC/tETH pool\'s price, taken at 80%', async () => {
  const tacPv = (units) => {
    const head = Array.from({ length: 19 }, () => word(0));
    head[7] = word(19 * 32);
    return '0x' + word(32) + head.join('') + word(1) + TAC_ASSET_ID.slice(2) + word(units);
  };
  const job = { ...boardJob(0n, 9), publicValues: tacPv(100n * 10n ** 8n) };            // 100 TAC
  const tacPool = '0x' + word(1) + ETH_ASSET_ID.slice(2) + TAC_ASSET_ID.slice(2) + word(440_000_000n) + word(8_524_000_000_000n) + word(30) + word(1);
  const none = world({ board: [job] });
  const r0 = makeRunner(cfgOf({ RUNNER_KEY: ANVIL0 }), { fetchImpl: none.fetchImpl, log: () => {} });
  assert.equal(await r0.passes.settles(), false, 'with no price read, TAC counts nothing');
  const { fetchImpl, seen } = world({ board: [job], tacPool });
  const r = makeRunner(cfgOf({ RUNNER_KEY: ANVIL0 }), { fetchImpl, log: () => {} });
  assert.equal(await r.passes.settles(), true, '100 TAC (~0.004 ETH) pays 400k gas at 1.1 gwei');
  assert.equal(seen.sent.length, 1);
});
