// lib/exit-reason.js: a prover binary's stop reason in one line, with URLs cut to their host.
// Run: node --test worker-relay/tests/exit-reason.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { exitReason, redactUrls } from '../src/lib/exit-reason.js';

const KEY = '0123456789abcdef0123456b4352e577fa708e0a';

test('an anyhow error and its causes are kept, not the tail that starts mid-key', () => {
  const err = [
    'bootstrapping helios on https://beacon.example/eth/' + KEY + ' (chain 1) bootstrap_slot=Some(1) pool=0xabc',
    `[debug] proof_rpc = https://mainnet.example.io/v3/${KEY}`,
    '[debug] about to call get_block, exec_block=23700000',
    'Error: [debug get_proof failed] server returned an error response: error code -32000: header not found',
    '',
    'Caused by:',
    `    0: error sending request for url (https://mainnet.example.io/v3/${KEY})`,
    '    1: operation timed out',
  ].join('\n');
  const r = exitReason({ out: '', err });
  assert.match(r, /^Error: \[debug get_proof failed\] .*header not found \| 0: error sending request .*\| 1: operation timed out$/);
  assert.ok(!r.includes(KEY.slice(-12)), 'no part of the key');
  assert.match(r, /https:\/\/mainnet\.example\.io\/…/);
  assert.ok(!r.includes('\n'));
});

test('a panic is reported with its message line', () => {
  const err = "STATE_PATH_DEBUG path=/x last_block=1\nthread 'main' panicked at src/bin/eth_prove.rs:463:14:\nno finalized execution header in finality_update\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n";
  assert.equal(exitReason({ err }), "thread 'main' panicked at src/bin/eth_prove.rs:463:14: | no finalized execution header in finality_update");
});

test('no error line: the last lines of stderr, else of stdout; nothing at all says so', () => {
  assert.equal(exitReason({ err: 'a\nb\nc\nd\n' }), 'b | c | d');
  assert.equal(exitReason({ out: 'x\ny\n' }), 'x | y');
  assert.equal(exitReason({}), 'no output');
});

test('a long reason is cut to its limit', () => {
  const r = exitReason({ err: `Error: ${'z'.repeat(1000)}` }, 100);
  assert.equal(r.length, 100); assert.ok(r.endsWith('…'));
});

test('URLs keep only scheme and host, userinfo dropped', () => {
  assert.equal(redactUrls('at https://user:pw@rpc.example.com/v2/secret?k=1 now'), 'at https://rpc.example.com/… now');
  assert.equal(redactUrls('(wss://node.example/ws/abc) done'), '(wss://node.example/…) done');
});
