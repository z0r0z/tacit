// The front page's zap sent without its proof (dapp/index.html zapNow), when the pool trades between the check and the block. The real source is cut out of the page and run with
// stand-ins (the technique of tests/zap-page-flows.test.mjs):
//   ZAP_RETRY    a revert is sent again twice at most in three minutes, and the way already chosen is not asked again
//   zapHead      the pool is read at the newest block any node reports, and a node that fails does not stop the zap
//   zapWay       says why the proof is not coming: used-up day, relay down, or just slow
//   paceTick     the countdown no longer ends in "a little longer" for ever
//   zapNow       re-plans on the pool as it is after any wait, keeps the quote to half a percent, retries a mined revert unless the route is a split
//   node --test tests/zap-fallback-robust.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
const cut = (a, b) => { const s = html.indexOf(a), e = html.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the page has ${a}`); return html.slice(s, e); };
const make = (src, names, stubs, returns) => new Function(...names, `${src}\nreturn { ${returns} };`)(...names.map((k) => stubs[k]));

// ── ZAP_RETRY ──
function retry(clock) {
  const real = Date.now; Date.now = () => clock.t;
  try { return { ...make(cut('const ZAP_RETRY = ', '\nconst ZAPWAY'), [], {}, 'ZAP_RETRY'), restore: () => { Date.now = real; } }; } catch (e) { Date.now = real; throw e; }
}
test('a reverted zap is sent again twice, then left, and the count starts over after three minutes', () => {
  const clock = { t: 1_000_000 }, { ZAP_RETRY, restore } = retry(clock);
  try {
    assert.deepEqual([ZAP_RETRY.take(), ZAP_RETRY.take(), ZAP_RETRY.take()], [true, true, false], 'two more tries, then it stops');
    clock.t += 179_000; assert.equal(ZAP_RETRY.take(), false, 'inside three minutes of the last try it is still counted');
    clock.t += 181_000; assert.equal(ZAP_RETRY.take(), true, 'three minutes after the last try it starts over');
  } finally { restore(); }
});
test('a try sets the way aside for ninety seconds, a refused one does not', () => {
  const clock = { t: 5_000_000 }, { ZAP_RETRY, restore } = retry(clock);
  try {
    assert.equal(ZAP_RETRY.way, 0);
    ZAP_RETRY.take(); assert.equal(ZAP_RETRY.way, clock.t);
    ZAP_RETRY.take(); const was = ZAP_RETRY.way; clock.t += 1000; ZAP_RETRY.take();
    assert.equal(ZAP_RETRY.way, was, 'the third is refused and leaves the mark where it was');
  } finally { restore(); }
});

// ── zapHead / zapReserves ──
const heads = (byUrl) => ({ RPCS: Object.keys(byUrl), rpc: async (m, p, urls) => { const v = byUrl[urls[0]]; if (v instanceof Error) throw v; return '0x' + v.toString(16); } });
test('the pool is read at the highest block any node reports, and a node that fails is skipped', async () => {
  const { zapHead } = make(cut('async function zapHead()', '\nasync function zapReserves'), ['RPCS', 'rpc'], heads({ a: 100, b: 102, c: new Error('down'), d: 101 }), 'zapHead');
  assert.equal(await zapHead(), '0x66', '102');
});
test('no node answering leaves the block as latest, and a failed read at the head falls back to a plain read', async () => {
  const { zapHead } = make(cut('async function zapHead()', '\nasync function zapReserves'), ['RPCS', 'rpc'], heads({ a: new Error('x'), b: new Error('y') }), 'zapHead');
  assert.equal(await zapHead(), 'latest');
  const calls = [];
  const { zapReserves } = make(cut('async function zapReserves(', '\nasync function zapRoute'), [], {}, 'zapReserves');
  const t = { poolReserves: async (id, blk) => { calls.push(blk); if (blk) throw new Error('header not found'); return { reserveA: 1n }; } };
  assert.deepEqual(await zapReserves(t, '0xp', '0x66'), { reserveA: 1n }, 'the read at the head failed, the plain one answered');
  assert.deepEqual(calls, ['0x66', undefined]);
  calls.length = 0; await zapReserves(t, '0xp', 'latest').catch(() => {});
  assert.deepEqual(calls, [undefined], 'with no head it reads once, plainly');
});

// ── zapWay ──
function wayText({ capped, down }) {
  const said = [];
  const html = (s, ...v) => s.reduce((a, x, i) => a + x + (i < v.length ? v[i] : ''), '');
  const { zapWay } = make(cut('function zapWay(', '\ndocument.addEventListener(\'click\', (e) => {\n  const b = e.target.closest?.(\'[data-zapway]\')'), ['ZAPWAY', 'VOUCH', 'html'], { ZAPWAY: { cb: null, then: null, id: 0 }, VOUCH: { capped }, html }, 'zapWay');
  zapWay({ tell: (m) => said.push(m), down });
  return said[0];
}
test('the prompt says why: used-up day, relay down, or just slow', () => {
  assert.match(wayText({ capped: Date.now() - 1000, down: false }), /Tacit’s free proofs for today are used up\./);
  assert.match(wayText({ capped: Date.now() - 1000, down: true }), /The proof can’t be made here right now\./, 'a relay that is down is said first');
  assert.match(wayText({ capped: Date.now() - 400e3, down: false }), /The proof is taking a little longer\./, 'a day that was used up long ago is not said now');
  assert.match(wayText({ capped: undefined, down: false }), /The proof is taking a little longer\./);
});

// ── the countdown ──
test('the countdown says how long it has taken once it is past its estimate', () => {
  const m = /const w = (spent < eta \? leftWords\(eta - spent\) : spent < eta \+ 15 \? 'a little longer' : `[^`]+`);/.exec(html);
  assert.ok(m, 'the page has the countdown line');
  const say = (spent, eta) => new Function('spent', 'eta', 'leftWords', 'clock', `return ${m[1]};`)(spent, eta, (s) => `about ${Math.round(s)} s`, (ms) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`);
  assert.equal(say(10, 35), 'about 25 s');
  assert.equal(say(40, 35), 'a little longer');
  assert.equal(say(330, 35), 'taking longer than usual, 5:30 so far');
});

// ── zapNow ──
const now = cut('async function zapNow(', '\nasync function zapShareFirst');
test('zapNow re-plans on the pool as it is after any wait, within half a percent of the quote', () => {
  assert.match(now, /let head = await zapHead\(\), res = await zapReserves\(t, p\.poolId, head\);/, 'the first plan is on the newest block');
  assert.match(now, /if \(!sp\) \{[^}]*head = await zapHead\(\);\s*const now = await zapReserves\(t, p\.poolId, head\)/s, 'and so is the second, after the waiting');
  assert.match(now, /fresh\.plan\.shares \* 1000n < z\.plan\.shares \* 995n/, 'a plan more than half a percent under the quote is not sent');
  assert.match(now, /plan = fresh\.plan; res = now;/, 'the plan and the reserves it was made on are the fresh ones');
  assert.doesNotMatch(now, /plan\.shares !== z\.plan\.shares \|\| plan\.value !== z\.plan\.value/, 'an exact match with the quote is no longer demanded');
  assert.match(now, /\['eth_call'|rpc\('eth_call', \[\{ from, to: ADDR\.confRouter, data, value: '0x' \+ plan\.value\.toString\(16\) \}, head\]\)/, 'the check before the send is on the same block as the plan');
  assert.ok(now.indexOf('head = await zapHead();') < now.indexOf('const index = t.nextShareIndex'), 'the re-plan comes before the share is built');
});
test('a mined revert is sent again, but not a split route, and not without a way to press again', () => {
  assert.match(now, /if \(hash && !landed && !splitRoute && again && \/reverted\/i\.test\(e\?\.message \|\| ''\) && ZAP_RETRY\.take\(\)\) \{ retry = true;/);
  assert.match(now, /if \(retry\) setTimeout\(\(\) => \{ again\(\)\.catch\(\(\) => \{\}\); \}, 2500\);/, 'the press goes again after the failure is shown');
  assert.match(now, /splitRoute = !!sp;/);
  assert.match(now, /if \(Date\.now\(\) - ZAP_RETRY\.way < 90e3\) break;/, 'the way chosen is not asked again');
});

// ── a zap that landed, and one still to finish ──
const steps = cut('async function zapFinishSteps(', '\n  if (st === 1n) {');
test('a zap in a block is read at the newest block and given time before it is called not landed', () => {
  assert.match(steps, /let st = held\(\) \? 2n : await depositAt\(await zapHead\(\)\);/, 'the deposit is read at the newest block');
  assert.match(steps, /if \(st === 0n && \(await rpc\('eth_getTransactionReceipt', \[rec\.tx\]\)\.catch\(\(\) => null\)\)\?\.status === '0x1'\) \{[^}]*for \(let i = 0; i < 6 && st === 0n; i\+\+\) \{ await sleep\(4000\); st = await depositAt\(await zapHead\(\)\); \}/s, 'a mined, successful zap is read again for about 24 s');
  assert.ok(steps.indexOf("status === '0x1'") < steps.indexOf("if (r?.status !== '0x0' && !late) return 'landing';"), 'and only then can it be called landing');
});
test('the Finish messages say what Finish does: farm it only where the zap was for the farm', () => {
  assert.equal((now.match(/\$\{bond \? 'put its share in the farm' : 'make its share private'\}/g) || []).length + (html.match(/\$\{bond \? 'put its share in the farm' : 'make its share private'\}/g) || []).length >= 3, true);
  assert.match(now, /Press Finish it in a minute to make its share private\$\{bond \? ' and farm it' : ''\}\./);
  assert.doesNotMatch(now, /Press Finish it in a minute to make its share private and farm it\.'/, 'the LP-only fallback no longer promises a farm');
});
const paint = cut('function hxPosPaint() {', '\n  const pair = (r) =>');
const clicks = cut('  el.onclick = (e) => {', "    if (b.dataset.padd != null) {");
test('the Yours list lists the zaps of this key still to finish, found from the chain whatever route the card is on', () => {
  assert.match(paint, /if \(S\.key\) zapsRead\(\);/, 'the chain is read for them when the list is drawn');
  assert.match(paint, /const waits = S\.key \? zapsKept\(\)\.filter\(\(z\) => z\.pub === S\.key\.pubHex && FARM\.program\?\.pools\?\.some\(\(x\) => x\.pid === z\.pid\)\) : \[\];/, 'only this key’s, and only for a pool the farm knows');
  assert.match(paint, /el\.hidden = !rows\.length && !\(rw > 0n\) && !waits\.length;/, 'a list with only a waiting zap is shown');
  const view = cut('  const waitRow = (z) =>', '\n  if (list.__h !== view.s)');
  assert.match(view, /data-pfin="\$\{z\.pid\}"/);
  assert.match(view, /const view = html`\$\{rows\.map\(row\)\}\$\{waits\.map\(waitRow\)\}\$\{turnRow\}`;/, 'after the positions, before the rewards row');
  assert.match(clicks, /\[data-pfin\]'\);\s*if \(!b \|\| b\.disabled\) return;\s*if \(b\.dataset\.pfin != null\) \{ const wp = FARM\.program\?\.pools\?\.find\(\(x\) => String\(x\.pid\) === b\.dataset\.pfin\); if \(wp\) hxFinishZap\(wp\); return; \}/, 'Finish runs the same finish as the card’s own');
});
test('finishing a zap that was LP only is labelled as making the share private, not farming it', () => {
  const fin = cut('async function zapsFinish(', '\nasync function zapQuote');
  assert.match(fin, /label: zs\.every\(\(z\) => z\.bond === false\) \? `Make your \$\{pairName\(p\.pair\)\} share private` : `Farm your \$\{pairName\(p\.pair\)\} share`/);
});
