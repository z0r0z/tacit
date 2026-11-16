// How a settle proof's private input is tried (src/lib/private-prove.js): a private attempt with part of the job's
// time, then one public attempt only when no prover proved it; never a public retry of a witness that cannot execute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { privateProvePlan, retryPublic, privateRefused, rememberRefusal, privateOff, PRIVATE_OFF_MS, unexecutable } from '../src/lib/private-prove.js';

test('a public input is one attempt with the whole time; so is a private one with the fallback off', () => {
  assert.deepEqual(privateProvePlan({}, 900_000), { fallback: false });
  assert.deepEqual(privateProvePlan({ PRIVATE_STDIN: '0' }, 900_000), { fallback: false });
  assert.deepEqual(privateProvePlan({ PRIVATE_STDIN: '1', PRIVATE_FALLBACK_PUBLIC: '0' }, 900_000), { fallback: false });
});

test('a private input gets at most six minutes or 60% of the job, leaving time for a public attempt', () => {
  assert.deepEqual(privateProvePlan({ PRIVATE_STDIN: '1' }, 900_000), { fallback: true, privateMs: 360_000 });
  assert.deepEqual(privateProvePlan({ PRIVATE_STDIN: '1' }, 300_000), { fallback: true, privateMs: 180_000 });
  assert.deepEqual(privateProvePlan({ PRIVATE_STDIN: '1', PRIVATE_ATTEMPT_MS: '120000' }, 900_000), { fallback: true, privateMs: 120_000 });
  assert.equal(privateProvePlan({ PRIVATE_STDIN: '1' }, 50_000).privateMs, 60_000, 'never under a minute');
});

test('only a request no prover proved is tried again in public', () => {
  assert.ok(retryPublic(new Error('exec:wrap timed out after 360000ms')));
  assert.ok(retryPublic(new Error('exec:wrap produced no proof (code=101): ENOENT\nError: Proof request 0xab… is unfulfillable')));
  assert.ok(retryPublic(new Error('exec:wrap produced no proof (code=101): …auction timed out')));
  assert.ok(!retryPublic(new Error('exec:wrap produced no proof (code=101): …request is unexecutable')));
  assert.ok(!retryPublic(new Error('VKEY DRIFT: derived … != pinned')));
  assert.ok(!retryPublic(new Error('Execution failed: exceeded cycle limit')));
});

test('the network\'s refusal of private inputs is recognised and remembered for ten minutes', () => {
  assert.equal(privateRefused(new Error('exec:wrap produced no proof (code=101): ENOENT\nthread main panicked: groth16 proof failed: status: PermissionDenied, message: "private stdin is not enabled on this network"')), true);
  assert.equal(privateRefused(new Error('exec:wrap produced no proof (code=101): the request expired')), false);
  assert.equal(privateOff(1_000_000), false);
  rememberRefusal(1_000_000);
  assert.equal(privateOff(1_000_000 + PRIVATE_OFF_MS - 1), true);
  assert.equal(privateOff(1_000_000 + PRIVATE_OFF_MS), false);
});

test('the refusal is seen on the binary\'s stderr, where a panic puts it, not only in the message', () => {
  const e = new Error('exec:wrap produced no proof (code=101): ENOENT: no such file or directory');
  assert.equal(privateRefused(e), false);
  e.stderr = 'thread main panicked: groth16 proof failed: status: PermissionDenied, message: "private stdin is not enabled on this network"';
  assert.equal(privateRefused(e), true);
  assert.equal(retryPublic(e), true);
});

test('the witness file outlives the private attempt, so the public retry can read it', async () => {
  const src = await readFile(new URL('../src/lib/prover.js', import.meta.url), 'utf8');
  const attempt = src.slice(src.indexOf('const attempt = async (extra, ms) => {'), src.indexOf('// The witness file stays for every attempt'));
  assert.ok(!/rm\(opFile/.test(attempt), 'an attempt must not remove the op file: the public retry reads it');
  assert.ok(/finally \{ await rm\(opFile, \{ force: true \}\); \}/.test(src), 'the op file is removed once every attempt is over');
});

test('a request the network will not run is never sent again in public, read from stderr where the panic puts it; an unfulfilled one still is', () => {
  const e = new Error('exec:farmunbond produced no proof (code=101): ENOENT: no such file or directory');
  assert.equal(retryPublic(e), true, 'no word of it yet');
  e.stderr = 'thread main panicked: groth16 proof failed: Proof request 0xa0afe9790c30 is unexecutable';
  assert.equal(unexecutable(e), true); assert.equal(retryPublic(e), false);
  assert.equal(retryPublic(Object.assign(new Error('x'), { unexecutable: true })), false, 'or marked by the attempt');
  const u = Object.assign(new Error('exec:wrap produced no proof (code=101): ENOENT'), { stderr: 'Proof request 0xab is unfulfillable' });
  assert.equal(unexecutable(u), false); assert.equal(retryPublic(u), true, 'unfulfillable: a public input can still find a prover');
  assert.equal(unexecutable(null), false);
});

test('the attempt turns the network\'s "unexecutable" into a plain refusal of the op: no file error, no key, nothing spent', async () => {
  const src = await readFile(new URL('../src/lib/prover.js', import.meta.url), 'utf8');
  const attempt = src.slice(src.indexOf('const attempt = async (extra, ms) => {'), src.indexOf('// The witness file stays for every attempt'));
  assert.ok(/is unexecutable\\b\/i\.test\(String\(err \|\| ''\)\)/.test(attempt), 'it reads stderr');
  assert.ok(/gone\.unexecutable = true/.test(attempt) && /nothing was spent/.test(attempt));
  assert.ok(attempt.indexOf('gone.unexecutable') < attempt.indexOf('produced no proof'), 'before the generic message is built');
});
