// After a claim lands, the balance the page shows follows it. A claimed note can be a moment behind in the read (the index follows the chain), and a scan, once made, is
// kept: nothing asked again for a long while, so a scan that missed the note left the old figure up. Now readAfterClaim (dapp/front/sheets.js) looks at the pool's leaf count
// again 10 s, 30 s and 90 s after a claim and reads the key again while the pool has leaves the scan did not cover. The real function is cut out of the sheets module and run
// against stand-ins (the technique of tests/zap-page-flows.test.mjs); how settleLocks reaches it is read from the source.
//   node --test tests/claim-refresh.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sheets = readFileSync(new URL('../dapp/front/sheets.js', import.meta.url), 'utf8');
const cut = (src, a, b) => { const s = src.indexOf(a), e = src.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the source has ${a}`); return src.slice(s, e); };

// `reads`: what each look finds, in order: 'same' (the scan covers every leaf), 'new' (the pool had more: a new scan), 'throw' (the leaf count could not be read)
function harness({ reads = ['same'], key = '02aa' } = {}) {
  const log = { waits: [], scans: 0, rerenders: [] };
  const ctx = {
    S: { key: key ? { pubHex: '02aa' } : null }, P: { scan: { id: 0 } },
    sleep: (ms) => { log.waits.push(ms); return ctx.gate ? ctx.gate.shift() || Promise.resolve() : Promise.resolve(); },
    scanIfNew: async () => {
      const r = reads[Math.min(log.scans, reads.length - 1)]; log.scans++;
      if (r === 'throw') throw new Error('leaf count unreadable');
      if (r === 'new') ctx.P.scan = { id: log.scans };
      return ctx.P.scan;
    },
    rerender: (n) => log.rerenders.push(n),
  };
  const src = cut(sheets, 'const CLAIM_REREAD', '// `onDone(lock, fee)`');
  const names = Object.keys(ctx);
  const fn = new Function(...names, `${src}\nreturn { readAfterClaim, CLAIM_REREAD, BALANCE_SHEETS };`)(...names.map((k) => ctx[k]));
  return { ...fn, ctx, log };
}

test('a scan that already covers every leaf is left alone: one look, no new read, nothing repainted', async () => {
  const h = harness({ reads: ['same'] });
  await h.readAfterClaim('02aa');
  assert.deepEqual(h.log.waits, [10e3], 'looked once, 10 s on');
  assert.equal(h.log.scans, 1);
  assert.deepEqual(h.log.rerenders, []);
});

test('a scan that missed the new note is read again, and the sheets that show balances are repainted', async () => {
  const h = harness({ reads: ['new', 'same'] });
  await h.readAfterClaim('02aa');
  assert.deepEqual(h.log.waits, [10e3, 30e3], '10 s, then 30 s, and it stops once the scan is current');
  assert.deepEqual(h.log.rerenders, h.BALANCE_SHEETS, 'every balance sheet repainted once, after the new read');
  assert.deepEqual(h.BALANCE_SHEETS, ['eth', 'tac', 'usdt', 'borrow', 'wallet']);
});

test('it is bounded: three looks at most, 10 s, 30 s and 90 s, however the pool moves', async () => {
  const h = harness({ reads: ['new'] });
  await h.readAfterClaim('02aa');
  assert.deepEqual(h.log.waits, [10e3, 30e3, 90e3]);
  assert.equal(h.log.scans, 3);
  assert.equal(h.log.rerenders.length, 3 * h.BALANCE_SHEETS.length);
  assert.deepEqual(h.CLAIM_REREAD, [10e3, 30e3, 90e3]);
});

test('a leaf count that cannot be read costs a look, not the loop', async () => {
  const h = harness({ reads: ['throw', 'new', 'same'] });
  await h.readAfterClaim('02aa');
  assert.deepEqual(h.log.waits, [10e3, 30e3, 90e3], 'the failed look is followed by the next');
  assert.equal(h.log.rerenders.length, h.BALANCE_SHEETS.length, 'only the look that found a new scan repainted');
});

test('another wallet opened, or the key locked, while waiting: nothing is read for the wrong key', async () => {
  const sw = harness({ reads: ['new'] });
  sw.ctx.S.key = { pubHex: '03bb' };
  await sw.readAfterClaim('02aa');
  assert.deepEqual([sw.log.waits.length, sw.log.scans], [1, 0], 'it waited, then saw another key');
  const locked = harness({ reads: ['new'] });
  locked.ctx.S.key = null;
  await locked.readAfterClaim('02aa');
  assert.equal(locked.log.scans, 0);
});

test('one loop at a time: a later claim restarts it and the earlier loop stops', async () => {
  let wakeA; const gateA = new Promise((r) => { wakeA = r; });
  const h = harness({ reads: ['same'] });
  h.ctx.gate = [gateA];                                   // the first look's wait is held; the second claim's is not
  const a = h.readAfterClaim('02aa');
  await new Promise((r) => setTimeout(r, 10));
  await h.readAfterClaim('02aa');                          // the later claim: its loop runs through
  assert.equal(h.log.scans, 1, 'the later loop made the one read');
  wakeA(); await a;
  assert.equal(h.log.scans, 1, 'the earlier loop woke, saw a newer one, and read nothing');
});

test('how it is reached: each payment is told as it goes through, and a claim that went through starts the looks after its scan', () => {
  assert.match(sheets, /ok\+\+;\n {6}try \{ onDone\?\.\(due, self \|\| lpP \? 0n : fee\); \} catch \{ \/\* telling is not worth stopping a claim \*\/ \}/, 'told per payment, and a failure to tell stops nothing');
  assert.match(sheets, /const pub = S\.key\?\.pubHex;\n {2}await scanPrivate\(true\)\.catch\(\(\) => \{\}\);\n {2}if \(ok && pub\) readAfterClaim\(pub\)\.catch\(\(\) => \{\}\);/, 'the looks follow the scan, only when something went through, and are not waited for');
  assert.match(sheets, /const told = \(l, f\) => toast\(html`Claimed \$\{lockWhat\(\[l\]\)\} sent to you\$\{f > 0n \? ', less the relay fee' : ''\}\.`\);/, 'auto-claim says so as each payment lands');
});
