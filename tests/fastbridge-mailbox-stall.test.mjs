// A provider's board inbox must keep being read: a request whose handler never returns, or a read that hangs, once left a provider that the
// setup script had started deaf for good (its ad on the board, its HTTP quote fine, every request through the board unanswered and nothing logged).
// And the config that setup writes must be one that serves the inbox. Over the board simulator, with real (short) timers.
//   node tests/fastbridge-mailbox-stall.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { makeBoard, signAd } from '../dapp/fastbridge-board.js';
import { gatewayOf, makeMailboxCall, makeMailboxServer } from '../dapp/fastbridge-mailbox.js';
import * as S from '../fastbridge-lp/lib/setup.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const T0 = 1_800_000_000;
const p = new Uint8Array(32).fill(7), keys = gatewayOf(p), gateway = bytesToHex(keys.pub), claimPub = bytesToHex(secp.getPublicKey(p, true));
const world = () => {
  const board = makeBoard({ now: () => T0 });
  board.putAd(signAd({ claimPub, gateway, btcAsset: '00'.repeat(32), evmAsset: 'cd'.repeat(32), minAmount: '50000', maxAmount: '100000', available: '100000', feeBps: 30, flatFee: '1000', csvBlocks: 144, evmWindowSecs: 14400, name: 'B', at: T0, until: T0 + 600 }, p));
  return board;
};
const ask = (board, path, timeoutMs = 3000) => makeMailboxCall({ board, gateway, claimPub, now: () => T0, pollMs: 10, timeoutMs })('GET', path);
const server = (board, handle, over = {}) => { const logs = []; const s = makeMailboxServer({ board, keys, handle, signReply: (d) => signSchnorr(d, p), now: () => T0, pollMs: 10, log: (l) => logs.push(l), ...over }); s.logs = logs; return s; };

test('a handler that never returns does not stop the inbox being read', async () => {
  const board = world();
  const s = server(board, async (req) => (req.path === '/hang' ? new Promise(() => {}) : { status: 200, body: { ok: req.path } }), { handleMs: 150 });
  s.start();
  const stuck = ask(board, '/hang', 400).catch((e) => e.message);
  const r = await ask(board, '/fine');
  assert.equal(r.status, 200); assert.equal(r.body.ok, '/fine');
  assert.match(await stuck, /did not answer/);
  assert.ok(s.logs.some((l) => /took over/.test(l.error || '')), 'the held request was said, not silent');
  s.stop();
});

test('a read that hangs is given up on and the inbox is read again', async () => {
  const board = world();
  let reads = 0;
  const live = { ...board, post: (...a) => board.post(...a), reply: (...a) => board.reply(...a), putReply: (...a) => board.putReply(...a), inbox: (...a) => (++reads === 1 ? new Promise(() => {}) : board.inbox(...a)) };
  const s = server(live, async () => ({ status: 200, body: { ok: 1 } }), { stuckMs: 120 });
  s.start();
  assert.equal((await ask(board, '/x')).status, 200);
  assert.ok(s.logs.some((l) => /stuck/.test(l.msg || '')));
  s.stop();
});

test('the config setup writes serves the inbox: a board, a poll of 1 s, and a request through the board is answered', async () => {
  const base = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.btc-eth.example.json', import.meta.url), 'utf8'));
  const rate = { num: 31n, den: 1n };
  const C = S.buildConfig({ base, name: 'B', terms: S.DEFAULT_TERMS, limits: S.deriveLimits({ privUnits: 3100000n * 2n, btcSats: 0n, rate, cap: 100000n }), dataDir: '/d' });
  assert.ok(Array.isArray(C.boards) && C.boards.length >= 1 && /^https:\/\//.test(C.boards[0]), 'server.mjs joins boards only when the config names some');
  assert.ok(C.mailboxPollSecs >= 1 && C.mailboxPollSecs <= 30, 'a poll interval the daemon takes');
  const board = world();
  const s = server(board, async () => ({ status: 200, body: { quoted: true } }), { pollMs: C.mailboxPollSecs * 1000 });
  s.start();
  assert.equal((await ask(board, '/info', 5000)).body.quoted, true);
  s.stop();
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} mailbox stall checks passed`);
process.exit(process.exitCode || 0);
