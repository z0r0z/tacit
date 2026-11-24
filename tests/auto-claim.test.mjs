// Payments sent to an open key are claimed for it without a press (dapp/auto-claim.js decides which, dapp/front/sheets.js autoClaim does it, dapp/index.html asks for it when
// payments have been read). The decision is tested on its own; the real autoClaim is cut out of the sheets module and run against stand-ins for the page's names (the technique of
// tests/zap-page-flows.test.mjs); the wiring is read from the source.
//   node --test tests/auto-claim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoClaimPick, autoClaimOff, autoClaimSet, autoClaimHint, autoClaimHeldByFee, autoClaimFeeShare, AUTO_CLAIM_SHARE, AUTO_CLAIM_MAX, AUTO_CLAIM_KEY, AUTO_CLAIM_TOLD } from '../dapp/auto-claim.js';
const HINT = ' Claiming is automatic: you can stop it in your wallet.';

const page = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8'), sheets = readFileSync(new URL('../dapp/front/sheets.js', import.meta.url), 'utf8');
const cut = (src, a, b) => { const s = src.indexOf(a), e = src.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the source has ${a}`); return src.slice(s, e); };

const lock = (n, amount = 200000n, deadline = 4102444800n + BigInt(n)) => ({ leaf: '0x' + String(n).padStart(2, '0').repeat(32), asset: '0xc0', amount: String(amount), deadline: String(deadline) });
const feeOf = (f) => () => f;

test('what is claimed unasked: a payment the fee takes a small share of, or none, and nothing else', () => {
  // the 11-24 test payment: 0.002 tETH (8 decimals) against a relay fee of 0.00023
  const a = lock(1, 200000n);
  assert.deepEqual(autoClaimPick({ locks: [a], fee: feeOf(23000n) }), { claim: [a], held: [] }, 'an 11.5% fee is claimed');
  assert.deepEqual(autoClaimPick({ locks: [a], fee: feeOf(0n) }).claim, [a], 'a claim that costs nothing (own prover, liquidity shares) is claimed');
  assert.equal(AUTO_CLAIM_SHARE, 15, 'the share is 15 percent');
  assert.deepEqual(autoClaimPick({ locks: [a], fee: feeOf(30000n) }).claim, [a], 'exactly 15% is claimed');
  const over = autoClaimPick({ locks: [a], fee: feeOf(30001n) });
  assert.deepEqual([over.claim.length, over.held[0].why], [0, 'fee'], 'a hair over 15% is left to the Claim button');
  assert.equal(autoClaimPick({ locks: [a], fee: feeOf(200000n) }).held[0].why, 'small', 'a fee that is the whole payment is not claimed');
  assert.equal(autoClaimPick({ locks: [a], fee: feeOf(500000n) }).held[0].why, 'small', 'nor one that is more');
  assert.equal(autoClaimPick({ locks: [a], fee: feeOf(null) }).held[0].why, 'unknown', 'a fee that could not be read is not guessed');
  assert.equal(autoClaimPick({ locks: [a], fee: feeOf(undefined) }).held[0].why, 'unknown');
  assert.deepEqual(autoClaimPick({ locks: [a], fee: feeOf(23000) }).claim, [a], 'a plain number is read too');
});

test('each payment is tried once a sitting, the most four are claimed, the soonest to lapse first', () => {
  const ls = [lock(1, 200000n, 500), lock(2, 200000n, 100), lock(3, 200000n, 300), lock(4, 200000n, 200), lock(5, 200000n, 400), lock(6, 200000n, 600)];
  const r = autoClaimPick({ locks: ls, fee: feeOf(1000n) });
  assert.equal(AUTO_CLAIM_MAX, 4);
  assert.deepEqual(r.claim.map((l) => l.deadline), ['100', '200', '300', '400'], 'four, the soonest deadlines first');
  assert.deepEqual(r.held.map((h) => [h.why, h.lock.deadline]), [['limit', '500'], ['limit', '600']], 'the rest wait for the button');
  const tried = new Set([r.claim[0].leaf.toLowerCase()]);
  const again = autoClaimPick({ locks: ls, fee: feeOf(1000n), tried });
  assert.ok(!again.claim.some((l) => l.leaf === r.claim[0].leaf) && again.held.some((h) => h.why === 'tried' && h.lock.leaf === r.claim[0].leaf), 'one already tried is not claimed again');
  assert.deepEqual(autoClaimPick({ locks: ls, fee: feeOf(1000n), max: 1 }).claim.length, 1, 'the most is a setting');
  assert.deepEqual(autoClaimPick({ locks: [], fee: feeOf(0n) }), { claim: [], held: [] }, 'nothing waiting, nothing to do');
  const upper = { ...lock(9), leaf: '0x' + 'AB'.repeat(32) };
  assert.equal(autoClaimPick({ locks: [upper], fee: feeOf(0n), tried: new Set(['0x' + 'ab'.repeat(32)]) }).held[0].why, 'tried', 'a leaf is matched without its case');
});

test('the switch: off in this browser stops it, anything else leaves it on, a browser with no storage leaves it on', () => {
  assert.equal(AUTO_CLAIM_KEY, 'tacit-auto-claim-v1');
  assert.equal(autoClaimOff((k) => (k === AUTO_CLAIM_KEY ? 'off' : null)), true);
  assert.equal(autoClaimOff(() => null), false);
  assert.equal(autoClaimOff(() => 'on'), false);
  assert.equal(autoClaimOff(() => { throw new Error('SecurityError'); }), false, 'a private window has no storage: it is on');
});

// the real autoClaim, run against stand-ins
const html = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? vals[i] : ''), '');
function memStore() { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; }
const noStore = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
function harness({ locks = [lock(1)], fee = 23000n, self = false, off = false, lp = false, settle = null, loadSwitchesKey = false, storage = memStore() } = {}) {
  const log = { settle: [], toasts: [], fails: [], ended: 0, loads: 0, rerenders: 0, runs: [], quotes: 0 };
  const ctx = {
    S: { key: { pubHex: '02aa' } }, LK: { pub: '02aa', mine: locks },
    lockList: () => ctx.LK.mine, loadLocks: async () => { log.loads++; if (loadSwitchesKey) ctx.LK.pub = 'other'; return ctx.LK; },
    getUx: async () => ({ quoteOpFee: async () => { log.quotes++; return fee; } }), proveOwn: async () => self, tickerOf: (t, asset) => (lp ? null : 'cETH'), lpPoolFor: async () => (lp ? { pid: 1 } : null),
    newRun: (sheet) => { const r = { sheet, away: false, fail: (el, e) => log.fails.push(e.message) }; log.runs.push(r); return r; }, endRun: () => { log.ended++; },
    toast: (m) => log.toasts.push(String(m)), html, lockWhat: (ls) => ls.map((l) => `${Number(l.amount) / 1e8} tETH`).join(' and '), rerender: () => { log.rerenders++; },
    autoClaimPick, autoClaimOff: (read) => (off ? true : autoClaimOff(read)), autoClaimSet, autoClaimHint,
    document: { getElementById: () => null, createElement: () => ({ setAttribute() {} }), body: { append() {} } }, localStorage: storage,
  };
  const settleStub = async (run, kind, status, only, onDone) => {
    log.settle.push({ run, kind, only: [...only], told: typeof onDone });
    if (settle) return settle(run, onDone);
    for (const l of locks.filter((x) => only.has(String(x.leaf).toLowerCase()))) onDone?.(l, self || lp ? 0n : BigInt(fee));       // each payment is told as it goes through
    return { ok: only.size, offered: false };
  };
  const src = cut(sheets, 'const ACLAIM = { busy: false, tried: new Set(), off: null };', 'return { renderProve, renderAct, autoClaim };');
  const names = Object.keys(ctx);
  const fn = new Function(...names, 'settleLocksReal', `const settleLocks = settleLocksReal;\n${src}\nreturn { autoClaim, ACLAIM, setAutoClaim, claimingOff };`)(...names.map((k) => ctx[k]), settleStub);
  return { ...fn, ctx, log, storage };
}

test('autoClaim: a payment the fee takes a small share of is claimed for the key, away from any sheet, and said in a note', async () => {
  const h = harness();
  await h.autoClaim();
  assert.equal(h.log.settle.length, 1);
  assert.deepEqual(h.log.settle[0].only, [lock(1).leaf.toLowerCase()], 'only that payment');
  assert.equal(h.log.settle[0].kind, 'claim');
  assert.deepEqual([h.log.runs[0].away, typeof h.log.runs[0].release, h.log.runs[0].sheet], [true, 'function', 'eth'], 'a run nobody watches: progress is in Activity');
  assert.deepEqual(h.log.toasts, ['Claimed 0.002 tETH sent to you, less the relay fee.' + HINT]);
  assert.equal(h.log.ended, 1, 'the run is ended');
  assert.ok(h.log.rerenders >= 1);
  await h.autoClaim();
  assert.equal(h.log.settle.length, 1, 'tried once: the same payment is not claimed again in this sitting');
});

test('autoClaim: where the claim costs nothing the note does not mention a fee; liquidity shares and the key\'s own prover are free', async () => {
  const own = harness({ self: true, fee: 999999999n });
  await own.autoClaim();
  assert.deepEqual(own.log.toasts, ['Claimed 0.002 tETH sent to you.' + HINT], 'own prover: claimed whatever the relay would ask');
  assert.equal(own.log.quotes, 0, 'and the relay is not asked its fee');
  const lp = harness({ lp: true, fee: 999999999n });
  await lp.autoClaim();
  assert.equal(lp.log.settle.length, 1);
  assert.deepEqual(lp.log.toasts, ['Claimed 0.002 tETH sent to you.' + HINT], 'liquidity shares carry no relay fee');
});

test('autoClaim: a payment the fee takes much of is left to the Claim button, and nothing runs', async () => {
  const h = harness({ fee: 100000n });
  await h.autoClaim();
  assert.deepEqual([h.log.settle.length, h.log.runs.length, h.log.toasts.length], [0, 0, 0]);
  const h2 = harness({ fee: null });
  await h2.autoClaim();
  assert.equal(h2.log.settle.length, 0, 'a fee that could not be read: not guessed');
});

test('autoClaim: off in this browser, another wallet opened meanwhile, no key, or nothing waiting: nothing is claimed', async () => {
  const off = harness({ off: true });
  await off.autoClaim();
  assert.deepEqual([off.log.loads, off.log.settle.length], [0, 0], 'off: nothing is even read');
  const sw = harness({ loadSwitchesKey: true });
  await sw.autoClaim();
  assert.equal(sw.log.settle.length, 0, 'the locks read belong to another key');
  const nokey = harness(); nokey.ctx.S.key = null;
  await nokey.autoClaim();
  assert.equal(nokey.log.loads, 0);
  const none = harness({ locks: [] });
  await none.autoClaim();
  assert.equal(none.log.settle.length, 0);
});

test('autoClaim: a claim that fails says so once, ends its run, and is not run again unasked; one the relay cannot take now is offered, not announced as claimed', async () => {
  const bad = harness({ settle: () => { throw new Error('relay refused'); } });
  await bad.autoClaim();
  assert.deepEqual(bad.log.fails, ['relay refused']);
  assert.equal(bad.log.ended, 1);
  assert.equal(bad.log.toasts.length, 0, 'no "claimed"');
  await bad.autoClaim();
  assert.equal(bad.log.settle.length, 1, 'a failed one is left to the button, not retried');
  const offered = harness({ settle: () => ({ ok: 0, offered: true }) });
  await offered.autoClaim();
  assert.equal(offered.log.toasts.length, 0, 'offered to be sent from the account: not "claimed"');
  assert.equal(offered.log.ended, 1);
});

test('autoClaim: each payment is told the moment it goes through, so a later step that fails does not leave it unsaid', async () => {
  const h = harness({ settle: (run, onDone) => { onDone(lock(1), 23000n); throw new Error('the rescan failed'); } });
  await h.autoClaim();
  assert.deepEqual(h.log.toasts, ['Claimed 0.002 tETH sent to you, less the relay fee.' + HINT], 'told before the failure');
  assert.deepEqual(h.log.fails, ['the rescan failed']);
  const ok = harness();
  await ok.autoClaim();
  assert.equal(ok.log.settle[0].told, 'function', 'the claim is handed the callback');
});

test('autoClaim: one at a time', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = harness({ settle: async () => { await gate; return { ok: 1, offered: false }; } });
  const first = h.autoClaim();
  await new Promise((r) => setTimeout(r, 20));
  await h.autoClaim();
  assert.equal(h.log.settle.length, 1, 'a second call while one is running does nothing');
  release(); await first;
  assert.equal(h.ACLAIM.busy, false, 'and the flag is cleared afterwards');
});

test('the switch is kept in the browser: off is stored, on takes it away, and a browser that keeps nothing says so', () => {
  const s = memStore();
  assert.equal(autoClaimSet(s, true), true);
  assert.equal(s.getItem(AUTO_CLAIM_KEY), 'off');
  assert.equal(autoClaimOff((k) => s.getItem(k)), true, 'what was set is what is read');
  assert.equal(autoClaimSet(s, false), true);
  assert.equal(s.getItem(AUTO_CLAIM_KEY), null, 'on is no entry at all');
  assert.equal(autoClaimOff((k) => s.getItem(k)), false);
  assert.equal(autoClaimSet(noStore, true), false, 'a private window cannot keep it');
  assert.equal(autoClaimSet(null, true), false, 'nor a browser with no storage object');
});

test('the hint is said once in a browser, never again, and never where it could not be remembered', () => {
  const s = memStore();
  assert.equal(AUTO_CLAIM_TOLD, 'tacit-auto-claim-told-v1');
  assert.deepEqual([autoClaimHint(s), autoClaimHint(s), autoClaimHint(s)], [true, false, false]);
  assert.equal(autoClaimHint(noStore), false, 'a browser that keeps nothing would say it every time: it does not');
  assert.equal(autoClaimHint(null), false);
});

test('the first note of a run says where to stop; the next payments and the next runs do not', async () => {
  const h = harness({ locks: [lock(1), lock(2)] });
  await h.autoClaim();
  assert.deepEqual(h.log.toasts, ['Claimed 0.002 tETH sent to you, less the relay fee.' + HINT, 'Claimed 0.002 tETH sent to you, less the relay fee.'], 'the hint once, on the first');
  assert.equal(h.storage.getItem(AUTO_CLAIM_TOLD), '1', 'and remembered');
  const again = harness({ locks: [lock(3)], storage: h.storage });
  await again.autoClaim();
  assert.deepEqual(again.log.toasts, ['Claimed 0.002 tETH sent to you, less the relay fee.'], 'a later run in the same browser does not repeat it');
  const nostore = harness({ storage: noStore });
  await nostore.autoClaim();
  assert.deepEqual(nostore.log.toasts, ['Claimed 0.002 tETH sent to you, less the relay fee.'], 'a browser that keeps nothing never gets the hint');
});

test('the wallet switch: stopping keeps the setting and stops claiming; turning it back on claims what is waiting', async () => {
  const h = harness();
  assert.equal(h.claimingOff(), false, 'on to begin with');
  h.setAutoClaim(true);
  assert.deepEqual([h.claimingOff(), h.storage.getItem(AUTO_CLAIM_KEY)], [true, 'off'], 'off, and kept');
  await h.autoClaim();
  assert.deepEqual([h.log.loads, h.log.settle.length], [0, 0], 'while off nothing is read or claimed');
  h.setAutoClaim(false);
  assert.deepEqual([h.claimingOff(), h.storage.getItem(AUTO_CLAIM_KEY)], [false, null], 'on again, the setting taken away');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.log.settle.length, 1, 'turning it on claims the payment that was waiting, with no press');
});

test('the wallet switch holds for this sitting even where the browser keeps nothing', async () => {
  const h = harness({ storage: noStore });
  h.setAutoClaim(true);
  assert.equal(h.claimingOff(), true, 'the sitting follows it');
  await h.autoClaim();
  assert.equal(h.log.settle.length, 0, 'and nothing is claimed');
  h.setAutoClaim(false);
  assert.equal(h.claimingOff(), false);
});

test('the wallet row: it names the state, offers the other, and presses through setAutoClaim', () => {
  assert.match(sheets, /<div class="kv"><span>Payments sent to you<\/span><b>\$\{claimingOff\(\) \? 'Claimed when you press' : 'Claimed for you'\}<\/b><button class="link" type="button" id="w-autoclaim"[^>]*>\$\{claimingOff\(\) \? 'claim for me' : 'stop claiming for me'\}<\/button><\/div>/, 'the row');
  assert.match(sheets, /\$\('#w-autoclaim'\)\.onclick = \(\) => \{ setAutoClaim\(!claimingOff\(\)\); keep\(\$\('#sheet-wallet'\), render\.wallet\); \};/, 'its press flips the switch and redraws the sheet');
  assert.match(sheets, /if \(ACLAIM\.busy \|\| !S\.key \|\| claimingOff\(\)\) return;/, 'the claim follows the same switch');
});

test('a payment is held by its fee when the fee is over the share and under the payment, and the share is said in whole percent that never reads as the limit', () => {
  assert.equal(autoClaimHeldByFee(200000n, 30000n), false, 'exactly 15% is not held');
  assert.equal(autoClaimHeldByFee(200000n, 30001n), true, 'a hair over is');
  assert.equal(autoClaimHeldByFee('200000', '40000'), true, 'strings as the lock records carry them');
  assert.equal(autoClaimHeldByFee(200000n, 200000n), false, 'a fee that is the whole payment is not offered, so not held');
  assert.equal(autoClaimHeldByFee(200000n, 900000n), false);
  assert.equal(autoClaimHeldByFee(200000n, null), false, 'a fee not known is not said');
  assert.equal(autoClaimHeldByFee(200000n, undefined), false);
  assert.equal(autoClaimHeldByFee(0n, 1n), false, 'nothing to take a share of');
  assert.equal(autoClaimHeldByFee(200000n, 20000n, 5), true, 'the share is a setting');
  assert.equal(autoClaimFeeShare(200000n, 40000n), 20);
  assert.equal(autoClaimFeeShare(160000n, 31000n), 19, '19.4% reads 19%');
  assert.equal(autoClaimFeeShare(200000n, 30008n), 16, 'a hair over 15% is held, and reads 16% not the limit itself');
  assert.equal(autoClaimFeeShare(0n, 5n), 0);
  // the one rule: what the picker holds for its fee is what the banner says it holds
  for (const [amount, share] of [[200000n, 15], [57n, 7], [1234567n, 15], [999n, 33], [100n, 15]]) {
    for (let f = 0n; f <= amount + 2n; f += amount > 5000n ? amount / 997n + 1n : 1n) {
      const picked = autoClaimPick({ locks: [lock(1, amount)], fee: () => f, share });
      assert.equal(picked.held.some((x) => x.why === 'fee'), autoClaimHeldByFee(amount, f, share), `amount ${amount}, fee ${f}, share ${share}`);
    }
  }
});

// the banner line, the real lockLine cut out of the page and run against stand-ins
function banner({ feeBy = {}, off = false, ux = {} } = {}) {
  const ctx = {
    lockWhat: (ls) => ls.map((l) => `${Number(l.amount) / 1e8} tETH`).join(' and '), inDays: () => '91 days', SP: { ux }, LK: { feeBy },
    fmt: (v, d) => String(Number(v) / 10 ** d), lockDec: () => 8, unitOf: () => 'tETH', dayFmt: () => '1 Dec',
    autoClaimOff: () => off, autoClaimHeldByFee, autoClaimFeeShare, AUTO_CLAIM_SHARE, localStorage: { getItem: () => null },
  };
  const src = cut(page, 'function lockLine(ls, kind) {', 'function waitingText(ps) {');
  const names = Object.keys(ctx);
  return new Function(...names, `${src}\nreturn lockLine;`)(...names.map((k) => ctx[k]));
}
const feeKey = (l) => l.leaf.toLowerCase();

test('the banner for a payment the fee takes much of says the fee and its share, and why it waits for the Claim button', () => {
  const a = lock(1, 150000n), line = banner({ feeBy: { [feeKey(a)]: 30000n } });
  assert.equal(line([a], 'claim'),
    'A private payment of 0.0015 tETH was sent to you. Claim it within 91 days. The relay’s fee to claim it is 0.0003 tETH, 20% of it: over the 15% that is claimed for you without a press, so press Claim to take it, or wait for the fee to fall.');
});

test('a payment claimed for the key, or one with no fee known, or the key claiming by press, gets the plain line', () => {
  const plain = 'A private payment of 0.002 tETH was sent to you. Claim it within 91 days.';
  const a = lock(1, 200000n);
  assert.equal(banner({ feeBy: { [feeKey(a)]: 23000n } })([a], 'claim'), plain, 'an 11.5% fee is claimed for the key: nothing to explain');
  assert.equal(banner({ feeBy: { [feeKey(a)]: 30000n } })([a], 'claim'), plain, 'exactly 15% is claimed too');
  assert.equal(banner({ feeBy: {} })([a], 'claim'), plain, 'no fee kept for it (the key proves on its own device, or it is liquidity shares): plain');
  assert.equal(banner({ feeBy: { [feeKey(a)]: 90000n }, off: true })([a], 'claim'), plain, 'with claiming switched off every payment waits for the press, so the share is not an explanation');
});

test('several payments: one held says its fee; more than one say how many', () => {
  const a = lock(1, 200000n), b = lock(2, 150000n), c = lock(3, 150000n);
  const one = banner({ feeBy: { [feeKey(a)]: 23000n, [feeKey(b)]: 30000n } })([a, b], 'claim');
  assert.equal(one, '2 private payments of 0.002 tETH and 0.0015 tETH were sent to you. Claim them within 91 days. The relay’s fee for one of them is 0.0003 tETH, 20% of it: over the 15% that is claimed for you without a press, so it waits for your press.');
  const two = banner({ feeBy: { [feeKey(a)]: 23000n, [feeKey(b)]: 30000n, [feeKey(c)]: 40000n } })([a, b, c], 'claim');
  assert.match(two, /^3 private payments of .* were sent to you\. Claim them within 91 days\. 2 of them have a relay fee over 15% of the payment, so they wait for your press\.$/);
});

test('with the sheets not loaded yet the share is still said, without the amount', () => {
  const a = lock(1, 150000n);
  const line = banner({ feeBy: { [feeKey(a)]: 30000n }, ux: null })([a], 'claim');
  assert.match(line, /The relay’s fee to claim it is 20% of it: over the 15%/);
});

test('loadLocks keeps the relay fee beside each payment it offers, and not on the record that goes to the claim', () => {
  assert.match(page, /const fees = \{\}, feeBy = \{\}, worth = async \(l\) => \{/, 'a map of fees by payment');
  assert.match(page, /if \(await worth\(l\)\) \{ mine\.push\(l\); const tk = tickerOf\(t, l\.asset\); if \(tk && fees\[tk\] != null\) feeBy\[String\(l\.leaf\)\.toLowerCase\(\)\] = fees\[tk\]; \}/, 'set for each payment offered, the record pushed as it is');
  assert.match(page, /Object\.assign\(LK, \{ at: Date\.now\(\), since, pub, mine, back, wait, small, smallBack, feeBy, root:/, 'and kept in LK');
  assert.match(page, /const LK = \{ at: 0, since: 0, pub: null, mine: \[\], back: \[\], wait: \[\], small: \[\], smallBack: \[\], feeBy: \{\},/, 'empty to begin with');
});

test('the wiring: the page asks when payments have been read, the sheets module claims only the picked ones, and both lists of names carry what it needs', () => {
  assert.match(page, /import \{ autoClaimPick, autoClaimOff, autoClaimSet, autoClaimHint, autoClaimHeldByFee, autoClaimFeeShare, AUTO_CLAIM_SHARE \} from '\/auto-claim\.js\?cb=/, 'the page imports the decision, the switch and the fee share');
  assert.match(page, /<!-- preload-roots:[^>]* \/lockmint-auto\.js \/auto-claim\.js /, 'and preloads it');
  const ask = cut(page, 'let autoClaimT = 0;', 'const isRwd');
  assert.match(ask, /if \(!S\.key \|\| LK\.pub !== S\.key\.pubHex \|\| !LK\.mine\.length \|\| autoClaimOff\(\(k\) => localStorage\.getItem\(k\)\)\) return;/, 'it asks only for the open key, with payments waiting, and not when switched off');
  assert.match(ask, /Promise\.resolve\(autoClaim\(\)\)/, 'the page asks its autoClaim');
  assert.match(page, /function autoClaim\(\.\.\.a\) \{ if \(SHEET_CODE\) return SHEET_CODE\.autoClaim\(\.\.\.a\); return withSheets\(\(\) => SHEET_CODE\?\.autoClaim\?\.\(\.\.\.a\)\); \}/, 'which is the sheets module\'s once it is loaded');
  assert.match(page, /runsPrune\(\);\n {4}autoClaimSoon\(\);\n {4}return LK;/, 'asked for each time payments are read');
  assert.match(sheets, /async function settleLocks\(run, kind, status, only = null, onDone = null\) \{/, 'the claim can be limited to some payments and tells each as it goes');
  assert.match(sheets, /mine = lockList\(kind\)\.filter\(\(l\) => !only \|\| only\.has\(String\(l\.leaf\)\.toLowerCase\(\)\)\)/);
  assert.match(sheets, /return \{ renderProve, renderAct, autoClaim \};/, 'and autoClaim is offered to the page');
  const names = 'newRun, endRun, autoClaimPick, autoClaimOff, lockWhat, autoClaimSet, autoClaimHint';
  assert.ok(page.includes(`pubHexOf, ${names}, get PTSINFO()`), 'the page hands the sheets module its names');
  assert.ok(sheets.includes(`pubHexOf, ${names} } = ctx;`), 'and the sheets module takes them');
});
