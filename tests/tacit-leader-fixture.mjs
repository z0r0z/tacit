// Drives tacit-block-node's leader (`serve`) with the fixture chain's real spends: for each block, POST its spends and settles, ask the
// leader to build the block (with the queue's entries, in calldata or blobs as the fixture's block was), require its guest input and
// public values to be the fixture's byte for byte, then tell the leader the block landed. Needs the built node binary:
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-leader-fixture.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, '../contracts/test/fixtures/tacit-blocks-mainnet.json');
const BIN = join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const MEMO_LEN = 1152;
const PORT = 18000 + Math.floor(Math.random() * 1000);
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const fx = JSON.parse(readFileSync(FX, 'utf8'));
const words = (pv) => { const b = bytes(pv); return Array.from({ length: b.length / 32 }, (_, i) => hx(b.subarray(32 * i, 32 * i + 32))); };

/// The buffers of a guest input file: u32 LE count, then each as a u32 LE length and its bytes.
function readStdin(file) {
  const n = file.readUInt32LE(0);
  let at = 4;
  const out = [];
  for (let i = 0; i < n; i++) { const len = file.readUInt32LE(at); out.push(file.subarray(at + 4, at + 4 + len)); at += 4 + len; }
  return out;
}

/// Spend data: 3 memo hashes ‖ exit address (20) ‖ salt (32) ‖ deposit opening ‖ exit opening ‖ [1 ‖ operation].
function opMemoHash(data) {
  let at = 148;
  at += data[at] === 1 ? 41 : 1;
  at += data[at] === 1 ? 41 : 1;
  if (data[at] !== 1) return [];
  const op = data.subarray(at + 1);
  return op[0] === 2 ? [op.subarray(op.length - 32)] : []; // a lock's memo hash is the end of its operation; a hop makes no note
}

async function call(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  return { ok: r.ok, status: r.status, ...j };
}

const server = spawn(BIN, ['serve', String(fx.chainId), `${fx.lander}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'inherit', 'inherit'] });
try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/state`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  let st = await call('GET', '/state');
  assert.equal(st.state, fx.genesisState, 'the leader starts at the fixture\'s genesis');
  assert.equal(st.chain, fx.chain);

  for (let b = 0; b < fx.blocks.length; b++) {
    const blk = fx.blocks[b];
    const file = readFileSync(`${FX}.b${b}.stdin`);
    const bufs = readStdin(file);
    const n = bufs[1].readUInt32LE(0);
    let at = 2;
    const spends = [];
    for (let k = 0; k < n; k++) { spends.push({ publics: bufs[at], proof: bufs[at + 1], data: bufs[at + 3] }); at += 4; }
    const nSettles = bufs[at++].readUInt32LE(0);
    const settles = [];
    for (let k = 0; k < nSettles; k++) settles.push(bufs[at++]);
    const time = Number(bufs[at++].readBigUInt64LE(0));
    const blobBuf = bufs[at++];
    const m = bufs[at++].readUInt32LE(0);
    const queue = [];
    for (let k = 0; k < m; k++) { queue.push(bufs[at]); at += 2; }

    // the memos published beside this block's new notes, found by their hashes
    const memoPool = Buffer.from(blk.memos.replace(/^0x/, ''), 'hex');
    const pool = Array.from({ length: memoPool.length / MEMO_LEN }, (_, k) => memoPool.subarray(MEMO_LEN * k, MEMO_LEN * (k + 1)));
    const { createHash } = await import('node:crypto');
    const memoHash = (x) => createHash('sha256').update(Buffer.concat([Buffer.from('tacit-block-memo-v1'), x])).digest();
    const byHash = (h) => { const f = pool.find((x) => memoHash(x).equals(h)); assert.ok(f, `block ${b}: a memo for ${h.toString('hex').slice(0, 8)}`); return f; };

    for (const s of spends) {
      const outs = [5, 6, 7].map((w) => s.publics.subarray(32 * w, 32 * w + 32)).map((x) => x.some((v) => v !== 0));
      const memos = [0, 1, 2].filter((k) => outs[k]).map((k) => hx(byHash(s.data.subarray(32 * k, 32 * k + 32))));
      const opMemos = opMemoHash(s.data).map((h) => hx(byHash(h)));
      const r = await call('POST', '/spend', { publics: hx(s.publics), proof: hx(s.proof), data: hx(s.data), memos, opMemos });
      assert.ok(r.ok, `block ${b}: spend refused: ${r.error}`);
    }
    for (const s of settles) {
      // a claim's or refund's note memo is the lock's claimTo/refundTo memo hash: the last 32 bytes of its terms' note
      const kind = s[0];
      const termsAt = 1 + 32 + 8;
      const claimMemo = s.subarray(termsAt + 40 + 64, termsAt + 40 + 96);
      const refundMemo = s.subarray(termsAt + 136 + 64, termsAt + 136 + 96);
      const r = await call('POST', '/settle', { settle: hx(s), memo: hx(byHash(kind === 1 ? claimMemo : refundMemo)) });
      assert.ok(r.ok, `block ${b}: settle refused: ${r.error}`);
    }
    const built = await call('POST', '/build', { time, blobs: blobBuf.length > 0, queue: queue.map(hx) });
    assert.ok(built.ok, `block ${b}: build refused: ${built.error}`);
    assert.equal(built.publicValues, blk.publicValues, `block ${b}: public values`);
    assert.equal(built.stdin, hx(file), `block ${b}: the leader's guest input is the fixture's`);
    if (blobBuf.length > 0) assert.equal(built.lists.blobs, blk.blobs, `block ${b}: blob openings`);
    for (const k of ['leaves', 'memos', 'deposits', 'exits', 'hops', 'claims']) {
      if (blobBuf.length > 0 && ['leaves', 'memos', 'claims'].includes(k)) continue;
      assert.equal(built.lists[k], blk[k] === '0x' ? '0x' : blk[k], `block ${b}: ${k}`);
    }
    const w = words(blk.publicValues);
    const landed = await call('POST', '/landed', { words: w, leaves: blk.leaves.length > 2 ? Array.from({ length: (blk.leaves.length - 2) / 64 }, (_, k) => '0x' + blk.leaves.slice(2 + 64 * k, 2 + 64 * (k + 1))) : [], memos: pool.map(hx), nullifiers: blk.nullifiers });
    assert.ok(landed.ok, `block ${b}: landing replay refused: ${landed.error}`);
    assert.equal(landed.state, w[1], `block ${b}: state after`);
    console.log(`block ${b}: ${n} spends, ${nSettles} settles, ${m} queued — built byte for byte, landed (state ${landed.state.slice(0, 10)}…)`);
  }
  st = await call('GET', '/state');
  console.log(JSON.stringify({ ok: true, height: st.height, leaves: st.leaves, nullifiers: st.nullifiers }));
} finally {
  server.kill();
}
