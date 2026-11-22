// The settle relay can run its loop more than once (SETTLE_CONCURRENCY). These read the sources as TEXT (importing settle-relay.js or prover.js pulls in the
// relay config, which needs RPC_URL) and pin what makes that safe: every wallet send takes the wallet's turn, the fallback prover's files are one proof at a time,
// the upkeep that sends from the wallet takes its turn only once it is due, a stop waits for every loop, and the default is the old single loop.
//   node --test worker-relay/tests/settle-concurrency.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, '..', 'src', f), 'utf8');
const relay = read('settle-relay.js'), prover = read('lib/prover.js'), config = read('lib/config.js');

test('the default is one loop, and the setting is read from SETTLE_CONCURRENCY', () => {
  assert.match(config, /settleConcurrency:\s*num\('SETTLE_CONCURRENCY',\s*1\)/);
});

test('every send from the settle wallet goes through the wallet turn (submitCall wraps sendCall)', () => {
  assert.match(relay, /const walletTurn = makeSerial\(\);/);
  assert.match(relay, /function submitCall\(base, label, opts = \{\}\) \{ return walletTurn\.run\(\(\) => sendCall\(base, label, opts\)\); \}/);
  assert.match(relay, /async function sendCall\(base, label,/);
  // the one place a transaction is written is inside sendCall, not outside the turn
  const inSend = relay.slice(relay.indexOf('async function sendCall('), relay.indexOf('async function sendCall(') + 20000);
  assert.ok(inSend.includes('wallet.writeContract(tx)'));
  assert.equal(relay.split('wallet.writeContract(').length - 1, 1, 'a second place writes a transaction');
  // nothing inside the turn asks for the turn again (it would wait on itself)
  const body = relay.slice(relay.indexOf('async function sendCall('), relay.indexOf('async function sendCall(') + 18000);
  assert.ok(!/\bsubmitCall\(/.test(body.split('\n// ')[0]) , 'sendCall calls submitCall');
});

test('the credit top-up and the PROVE deposit take the wallet turn once due, not on every pass', () => {
  const rep = relay.slice(relay.indexOf('async function maybeReplenish()'), relay.indexOf('async function replenishNow()'));
  assert.match(rep, /replenishDue\(/);
  assert.match(rep, /await walletTurn\.run\(replenishNow\);/);
  assert.ok(rep.indexOf('replenishDue(') < rep.indexOf('walletTurn.run('), 'the turn is taken before the due check');
  assert.match(relay, /walletTurn\.run\(\(\) => depositArrivedProve\(/);
  // the pass itself calls them bare (loop 0 must not wait out another loop's settle on every pass)
  assert.match(relay, /await maybeReplenish\(\);\n\s*await maybeDepositArrived\(\);/);
});

test('main runs CFG.settleConcurrency loops (capped at 4), loop 0 does the upkeep, and the process exits only after every loop has left', () => {
  assert.match(relay, /Math\.max\(1, Math\.min\(4, Math\.floor\(CFG\.settleConcurrency\) \|\| 1\)\)/);
  assert.match(relay, /await runLoops\(\{\s*count,\s*stopping: \(\) => stopping,\s*stopped: async \(\) => \{ log\('stopped cleanly'\); process\.exit\(0\); \}/);
  assert.match(relay, /if \(i > 0\) \{ if \(!worked\) await idleWait\(\); return; \}/);
  // the old loop's direct exit is gone: one loop leaving must not cut another's job off
  assert.ok(!/if \(stopping\) \{ log\('stopped cleanly'\); process\.exit\(0\); \}/.test(relay));
  // loop 0 keeps every piece of upkeep it had
  for (const piece of ['gasCycle()', "sendBeatIdle('idle — queue empty')", 'abandoned.sweep()', 'maybeReplenish()', 'maybeDepositArrived()']) assert.ok(relay.includes(piece), piece);
});

test('the fallback prover works through its files one proof at a time, and frees them on every path', () => {
  assert.match(prover, /const fallbackFiles = makeSerial\(\);/);
  const at = prover.indexOf('const releaseFiles = await fallbackFiles.acquire();');
  assert.ok(at > 0, 'the files are not taken');
  const w = prover.indexOf('await writeFile(opFile,');
  assert.ok(w > at, 'the op file is written before the turn is taken');
  // a failure between taking the turn and the try/finally frees it
  assert.match(prover.slice(at, at + 600), /catch \(e\) \{ releaseFiles\(\); throw e; \}/);
  assert.match(prover, /try \{ return await attempts\(\); \} finally \{ await rm\(opFile, \{ force: true \}\); releaseFiles\(\); \}/);
  // only the file-based section is inside the turn: the board lane runs before it
  assert.ok(prover.indexOf('viaBoard({ stdin, ...LIMITS[type]') < at, 'the board lane is inside the file turn');
});
