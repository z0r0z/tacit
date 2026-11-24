// The real leader follows a chain on which another leader landed a block with its data in blobs: it reads the blobs from a blob source (waiting and trying again
// while none holds them), tells the node of the block, and keeps it on disk; a block it already has a file for is not looked up at all.
//   node tests/tacit-leader-blob-sync.test.mjs
// A fake Ethereum RPC, a fake tacit-block-node (a script that answers the leader's calls and keeps what it is told) and a fake blob source stand in for the real ones.
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { archiveEntry } from '../tacit-leader/archive.mjs';
import { hexOf, landCalldata, selector } from '../tacit-leader/abi.mjs';
import { openingHashes } from '../tacit-leader/blobs.mjs';
import { block } from './lib/leader-blob-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const topic = (sig) => hexOf(keccak_256(new TextEncoder().encode(sig)));
const T_LANDED = topic('Landed(uint256,bytes32,bytes32,address)');
const pad = (hex) => '0x' + hex.replace(/^0x/, '').padStart(64, '0');
const word = (n) => pad(BigInt(n).toString(16));
const BLOCKS = '0x' + '11'.repeat(20);

// the block that landed (height 1, in Ethereum block 50), and what its land call carried
const b = block(5, 6, 1);
const state = hexOf(b.pv.subarray(32, 64)), root = hexOf(b.pv.subarray(96, 128));
const none = new Uint8Array(0);
const input = hexOf(landCalldata(b.pv, new Uint8Array(8), { leaves: none, memos: none, nullifiers: [], anchors: [], deposits: none, exits: none, hops: none, claims: none, blobs: b.openings }));
const [vh] = openingHashes(b.openings);

const sel = Object.fromEntries(['height()', 'TAC_ASSET()', 'queued()', 'queueDone()', 'lastLanded()', 'WINDOW()', 'FORCE_DELAY()', 'seats()'].map((s) => [hexOf(selector(s)), s]));
const values = { 'TAC_ASSET()': '0x' + 'aa'.repeat(32), 'WINDOW()': word(600), 'FORCE_DELAY()': word(3600) };
const rpcServer = () => http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const { method, params, id } = JSON.parse(body);
    const answers = {
      eth_chainId: () => '0x1',
      eth_blockNumber: () => '0x64',
      eth_call: () => values[sel[String(params[0].data).slice(0, 10)]] ?? word(0),
      eth_getLogs: () => (params[0].topics?.[0] === T_LANDED && parseInt(params[0].fromBlock, 16) <= 50 && 50 <= parseInt(params[0].toBlock, 16)
        ? [{ topics: [T_LANDED, word(1), pad('0x' + 'cc'.repeat(20))], data: state + root.slice(2), transactionHash: '0x' + 'dd'.repeat(32), blockNumber: '0x32' }] : []),
      eth_getTransactionByHash: () => ({ input }),
    };
    const result = answers[method]?.();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } } : { jsonrpc: '2.0', id, result }));
  });
});

// tacit-block-node's part in this: it serves the addresses the leader calls and keeps what /landed is told (read back at /_landed)
const FAKE_NODE = `#!/usr/bin/env node
import http from 'node:http';
const [host, port] = process.argv[4].split('@')[1].split(':');
const landed = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/_landed') return send(landed);
    if (req.method === 'POST' && req.url === '/landed') { landed.push(JSON.parse(body)); return send({ ok: true }); }
    if (req.url === '/mempool' || req.url === '/pending') return send({ spends: [], settles: [] });
    return send({ state: '0x${'00'.repeat(32)}', ok: true });
  });
}).listen(Number(port), host);
`;

async function run({ name, archived, failFirst }) {
  const dir = mkdtempSync(join(tmpdir(), 'leader-blob-sync-'));
  const [rpcPort, nodePort, blobPort] = [await freePort(), await freePort(), await freePort()];
  const rpc = rpcServer().listen(rpcPort, '127.0.0.1');
  const hits = [];
  let refused = 0;
  const blobs = http.createServer((req, res) => {
    hits.push(req.url);
    if (refused < failFirst) { refused++; res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/octet-stream');
    res.end(Buffer.from(b.blobs[0]));
  }).listen(blobPort, '127.0.0.1');
  const nodeBin = join(dir, 'fake-node.mjs');
  writeFileSync(nodeBin, FAKE_NODE);
  chmodSync(nodeBin, 0o755);
  const archive = join(dir, 'archive');
  if (archived) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, '1.json'), JSON.stringify(archiveEntry(b.pv, { leaves: Uint8Array.from(b.outputs.flatMap(([l]) => [...l])), memos: Uint8Array.from(b.outputs.flatMap(([, m]) => [...m])), nullifiers: b.nullifiers.map(hexOf) }, 50)));
  }
  const lines = [];
  const child = spawn(process.execPath, [join(HERE, '../tacit-leader/leader.mjs')], {
    env: { PATH: process.env.PATH, HOME: dir, RPC_URL: `http://127.0.0.1:${rpcPort}`, BLOCKS, FROM_BLOCK: '1', LEADER_KEY: '0x' + '11'.repeat(32), NODE_BIN: nodeBin, NODE_ADDR: `127.0.0.1:${nodePort}`, ARCHIVE_DIR: archive, POLL_SECS: '1', BLOB_URLS: `http://127.0.0.1:${blobPort}/blobs/{hash}`, BLOB_RETRY_SECS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { lines.push(JSON.parse(l)); } catch { /* not a log line */ } } });
  const until = (f, what, ms = 40_000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => { const hit = lines.find(f); if (hit) return res(hit); if (Date.now() - t0 > ms) return rej(new Error(`${name}: no ${what}; saw ${JSON.stringify(lines.map((l) => Object.keys(l).filter((k) => k !== 't').join('+')))}`)); setTimeout(tick, 100); };
    tick();
  });
  try {
    if (failFirst) {
      const miss = await until((l) => l.blobsUnread === 1, 'blobsUnread');
      assert.equal(miss.retryInSecs, 1, 'it says when it will look again');
      assert.ok(miss.sources?.length === 1 && miss.sources[0].error, 'and which source said no, and why');
      assert.ok(!lines.some((l) => l.synced), 'the block is not passed over');
    }
    await until((l) => l.synced === 1, 'synced');
    if (archived) assert.equal(hits.length, 0, `${name}: a block with a file is not looked up`);
    else {
      assert.equal(lines.filter((l) => l.blobsRead === 1).length, 1, 'read once');
      assert.ok(hits.length >= failFirst + 1 && hits.every((u) => u === `/blobs/${vh}`), 'the blob was asked for by its versioned hash');
    }
    const errors = lines.filter((l) => l.error && !l.blobsUnread);
    assert.ok(!errors.length, `${name}: nothing logged as an error: ${JSON.stringify(errors)}`);
    const told = await (await fetch(`http://127.0.0.1:${nodePort}/_landed`)).json();
    assert.equal(told.length, 1, 'the node is told of the block once');
    assert.equal(told[0].words.length, 19);
    assert.equal(told[0].words[1], state);
    assert.deepEqual(told[0].leaves, b.outputs.map(([l]) => hexOf(l)), 'its new notes');
    assert.deepEqual(told[0].memos, b.outputs.map(([, m]) => hexOf(m)), 'with their memos');
    assert.deepEqual(told[0].nullifiers, b.nullifiers.map(hexOf), 'and its nullifiers');
    const kept = JSON.parse(readFileSync(join(archive, '1.json'), 'utf8'));
    assert.equal(kept.lists.leaves, hexOf(Uint8Array.from(b.outputs.flatMap(([l]) => [...l]))), 'kept on disk for a restart');
    assert.deepEqual(kept.lists.nullifiers, b.nullifiers.map(hexOf));
    return lines;
  } finally {
    child.kill('SIGTERM');
    await new Promise((res) => { child.on('exit', res); setTimeout(res, 3000); });
    rpc.close(); blobs.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

assert.ok(existsSync(join(HERE, '../tacit-leader/leader.mjs')));
await run({ name: 'blobs, the first look finds none', archived: false, failFirst: 1 });
await run({ name: 'a file for the block', archived: true, failFirst: 0 });
console.log('tacit-leader blob sync: ok');
process.exit(0);
