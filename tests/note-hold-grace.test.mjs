// dapp/index.html: (1) a run that went through keeps its notes held for two minutes after its last job ended, so a row whose note was just spent does not come back while a node
// is still a block behind; (2) a relay refusal that names its error before the selector, "(NullifierAlreadySpent 0xb115d857)", is said in plain words.
//   node --test tests/note-hold-grace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frontPage } from './lib/front-page.mjs';
const html = frontPage(new URL('../dapp/index.html', import.meta.url));
const cut = (a, b) => { const s = html.indexOf(a), e = html.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the page has ${a}`); return html.slice(s, e); };
function holder(jobs, { scanSince = 0 } = {}) {
  const stubs = { actGet: (id) => jobs[id], P: { scan: { since: scanSince } }, LK: { since: 0 }, ended: (j) => j.status === 'settled' || j.status === 'failed', okStatus: (s) => s === 'settled' || s === 'confirmed' };
  const src = `${cut('const openJobs = ', '\nfunction taken(key)')}`;
  const { holds } = new Function(...Object.keys(stubs), `${src}\nreturn { holds };`)(...Object.values(stubs));
  return holds;
}
const NOW = Date.now();
const run = (ids) => ({ live: false, jobs: ids, keys: new Set(['n:a']) });
test('a settled job keeps its notes held two minutes after it ended, even when a newer scan has come in', () => {
  const holds = holder({ j1: { status: 'settled', end: NOW - 10e3 } }, { scanSince: NOW - 5e3 });
  assert.equal(holds(run(['j1']), 'n:a'), true, '10 s after it settled, the newer scan is not trusted yet');
});
test('after the two minutes the note is free for the scan to say', () => {
  const holds = holder({ j1: { status: 'settled', end: NOW - 130e3 } }, { scanSince: NOW - 5e3 });
  assert.equal(holds(run(['j1']), 'n:a'), false);
});
test('a job that failed gives its notes back as soon as a newer scan has come in: they were not spent', () => {
  const holds = holder({ j1: { status: 'failed', end: NOW - 10e3 } }, { scanSince: NOW - 5e3 });
  assert.equal(holds(run(['j1']), 'n:a'), false);
});
test('a run still live, or with a job still open, holds as before', () => {
  assert.equal(holder({})({ live: true, jobs: [], keys: new Set(['n:a']) }, 'n:a'), true);
  assert.equal(holder({ j1: { status: 'queued' } })(run(['j1']), 'n:a'), true);
});
test('the relay\'s "(NullifierAlreadySpent 0xb115d857)" is said as the plain line, and the old forms still are', () => {
  const REVERTS = { b115d857: 'It has already gone through: its note is spent. Check your balance before sending it again.', '29b3c833': 'The pool moved.' };
  const { revertText } = new Function('REVERTS', `${cut('function revertText(e) {', '\n// What a call that failed to run says')}\nreturn { revertText };`)(REVERTS);
  assert.match(revertText({ message: 'settle failed: the pool refused this op as it stands (NullifierAlreadySpent 0xb115d857); it was not proved again and nothing was spent' }), /already gone through/);
  assert.equal(revertText({ message: 'x (0x29b3c833) y' }), 'The pool moved.');
  assert.equal(revertText({ message: 'execution reverted: 0x29b3c833' }), 'The pool moved.');
  assert.equal(revertText({ data: '0xb115d857' }), REVERTS.b115d857);
  assert.equal(revertText({ message: 'nothing like it' }), undefined);
});
