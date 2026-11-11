// A wallet that answers each request in its own window (Rainbow's extension) closes the window just after the answer and turns down
// whatever the page still has open when it goes. A permit signed and the deposit sent at once lost the deposit to that, shown as
// "Cancelled in your wallet" though nobody cancelled. dapp/wallet-prompts.js leaves a quiet after each answered prompt and asks once
// more for a request refused faster than anyone could read it.
//
// The wallet here is a model of that window: a request made while the last window is still closing is refused when it closes, one made
// after it opens a new window and waits for the person. The first sections run on a virtual clock; the last drives the page's own wallet
// module (dapp/evm-wallet.js) through a permit and a deposit against the same model, in real time.
//
// Run: `node tests/wallet-prompts.test.mjs`

import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;

import { secp, sha256, keccak_256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { prfBytesToScalar } from '../dapp/prf-wallet.js';
import { guardProvider, declinedWords, stillWaiting, QUIET_MS, RETRY_QUIET_MS, QUICK_MS, SLOW_MS } from '../dapp/wallet-prompts.js';
import { makeEvmWallet } from '../dapp/evm-wallet.js';
import { UserStopped } from '../dapp/trade/wallet.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond === true) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } };
const rejected = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });

function makeClock() {
  let t = 1_000_000;
  const timers = [];
  const clock = {
    now: () => t,
    at: (when, fn) => { timers.push({ at: when, fn }); },
    after: (ms, fn) => clock.at(t + ms, fn),
    sleep: (ms) => new Promise((done) => clock.after(ms, done)),
    async run(p) {
      let settled = false, value, error;
      p.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
      for (;;) {
        await new Promise((r) => setImmediate(r));
        if (settled) break;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        if (!next) { await new Promise((r) => setImmediate(r)); if (settled) break; throw new Error('the clock has nothing left to run and the call has not ended'); }
        t = Math.max(t, next.at);
        next.fn();
      }
      if (error) throw error;
      return value;
    },
  };
  return clock;
}

// `think`: how long the person takes to answer a window. `closeAfter`: how long the window takes to go once answered.
// `decide(n)`: 'ok' or 'no' for the n-th window (a person refusing).
function rainbowLike(clock, { think = 3000, closeAfter = 300, decide = () => 'ok' } = {}) {
  let closing = false, closesAt = 0, windows = 0;
  const open = new Set();
  const seen = [];
  const closeWindow = () => { closing = false; for (const no of [...open]) { open.delete(no); no(rejected()); } };
  const provider = {
    seen,
    async request({ method }) {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_call') return '0x';
      seen.push({ method, at: clock.now() });
      if (closing) return new Promise((_, no) => { open.add(no); });
      const n = ++windows;
      return new Promise((res, no) => {
        clock.after(think, () => {
          if (decide(n) === 'no') { closing = true; clock.after(closeAfter, closeWindow); no(rejected()); return; }
          closing = true; closesAt = clock.now() + closeAfter;
          clock.after(closeAfter, closeWindow);
          res(method === 'eth_sendTransaction' ? '0x' + 'ab'.repeat(32) : '0x' + '11'.repeat(65));
        });
      });
    },
  };
  return provider;
}

const SIGN = { method: 'eth_signTypedData_v4', params: [] };
const SEND = { method: 'eth_sendTransaction', params: [] };

console.log('\n— the wallet model refuses a prompt made as the last window closes (control)');
{
  const clock = makeClock(), p = rainbowLike(clock, { think: 3000, closeAfter: 300 });
  await clock.run(p.request(SIGN));
  const err = await clock.run(p.request(SEND)).then(() => null, (e) => e);
  ok('unguarded: the deposit right after the permit is refused with code 4001', err?.code === 4001);
}

console.log('\n— a guarded provider: the permit, then the deposit at once');
{
  const clock = makeClock(), p = guardProvider(rainbowLike(clock, { think: 3000, closeAfter: 300 }), { now: clock.now, sleep: clock.sleep });
  const permit = await clock.run(p.request(SIGN));
  const answered = clock.now();
  const hash = await clock.run(p.request(SEND)).then((h) => h, (e) => e);
  ok('the permit is signed', typeof permit === 'string' && permit.length === 132);
  ok('the deposit is sent, not refused', typeof hash === 'string' && hash.length === 66);
  const sent = p.seen.filter((x) => x.method === 'eth_sendTransaction');
  ok('the wallet saw the deposit once', sent.length === 1);
  ok(`and not sooner than ${QUIET_MS} ms after the permit was answered`, sent[0].at - answered >= QUIET_MS);
}

console.log('\n— a window slower to close than the quiet: the refusal is not the person\'s, so it is asked again');
{
  const clock = makeClock(), p = guardProvider(rainbowLike(clock, { think: 3000, closeAfter: 2500 }), { now: clock.now, sleep: clock.sleep });
  await clock.run(p.request(SIGN));
  const hash = await clock.run(p.request(SEND)).then((h) => h, (e) => e);
  ok('the deposit is sent after the second ask', typeof hash === 'string' && hash.length === 66);
  ok('the wallet was asked for it twice', p.seen.filter((x) => x.method === 'eth_sendTransaction').length === 2);
}

console.log('\n— a person who declines is not asked again');
{
  const clock = makeClock(), p = guardProvider(rainbowLike(clock, { think: 6000, decide: (n) => (n === 2 ? 'no' : 'ok') }), { now: clock.now, sleep: clock.sleep });
  await clock.run(p.request(SIGN));
  const err = await clock.run(p.request(SEND)).then(() => null, (e) => e);
  ok('the refusal comes back as it was, code 4001', err?.code === 4001 && !err.quick);
  ok('the wallet was asked for the deposit once', p.seen.filter((x) => x.method === 'eth_sendTransaction').length === 1);
}

console.log('\n— a wallet that refuses at once, twice');
{
  const clock = makeClock(), p = guardProvider(rainbowLike(clock, { think: 50, closeAfter: 10, decide: () => 'no' }), { now: clock.now, sleep: clock.sleep });
  const err = await clock.run(p.request(SEND)).then(() => null, (e) => e);
  ok('asked twice and no more', p.seen.length === 2);
  ok('the error keeps code 4001 and says it was at once', err?.code === 4001 && err.quick === true);
  ok(`the second ask waited out the longer quiet (${RETRY_QUIET_MS} ms)`, p.seen[1].at - p.seen[0].at >= RETRY_QUIET_MS);
}

console.log('\n— how long a window takes to close decides whether the short quiet is enough');
for (const closeAfter of [300, 500]) {
  const clock = makeClock(), p = guardProvider(rainbowLike(clock, { think: 3000, closeAfter }), { now: clock.now, sleep: clock.sleep });
  await clock.run(p.request(SIGN));
  const answered = clock.now();
  const hash = await clock.run(p.request(SEND)).then((h) => h, (e) => e);
  const sent = p.seen.filter((x) => x.method === 'eth_sendTransaction');
  ok(`a window that takes ${closeAfter} ms to close: the next prompt goes ${QUIET_MS} ms after the answer, once, and is sent`, typeof hash === 'string' && sent.length === 1 && sent[0].at - answered === QUIET_MS);
}
for (const closeAfter of [900, 1400]) {
  const clock = makeClock(), p = guardProvider(rainbowLike(clock, { think: 3000, closeAfter }), { now: clock.now, sleep: clock.sleep });
  await clock.run(p.request(SIGN));
  const answered = clock.now();
  const hash = await clock.run(p.request(SEND)).then((h) => h, (e) => e);
  const sent = p.seen.filter((x) => x.method === 'eth_sendTransaction');
  ok(`a window that takes ${closeAfter} ms to close: the refusal is not the person's, so it is asked again after ${RETRY_QUIET_MS} ms and sent`, typeof hash === 'string' && sent.length === 2 && sent[1].at - (answered + closeAfter) >= RETRY_QUIET_MS);
}

console.log('\n— what is not a prompt, and what is not a refusal');
{
  const clock = makeClock(), inner = rainbowLike(clock);
  const p = guardProvider(inner, { now: clock.now, sleep: clock.sleep });
  await clock.run(p.request(SIGN));
  const t0 = clock.now();
  const chain = await clock.run(p.request({ method: 'eth_chainId' }));
  ok('a read goes straight through, right after a prompt', chain === '0x1' && clock.now() === t0);
  const odd = { request: async ({ method }) => { odd.n = (odd.n || 0) + 1; throw Object.assign(new Error('request of type eth_sendTransaction already pending'), { code: -32002 }); } };
  const q = guardProvider(odd, { now: clock.now, sleep: clock.sleep });
  const e2 = await clock.run(q.request(SEND)).then(() => null, (e) => e);
  ok('another error is thrown as it came, with no second ask', e2?.code === -32002 && odd.n === 1);
  const slowNo = { request: async () => { await clock.sleep(QUICK_MS + 500); throw rejected(); } };
  const s = guardProvider(slowNo, { now: clock.now, sleep: clock.sleep });
  const e3 = await clock.run(s.request(SEND)).then(() => null, (e) => e);
  ok(`a refusal after more than ${QUICK_MS} ms is the person's and is not asked again`, e3?.code === 4001 && !e3.quick);
}

console.log('\n— an answer made with no window (a site the wallet already allows) starts no quiet');
{
  const clock = makeClock(), calls = [];
  const allowed = { request: async ({ method }) => { calls.push({ method, at: clock.now() }); return '0x1'; } };
  const p = guardProvider(allowed, { now: clock.now, sleep: clock.sleep });
  await clock.run(p.request({ method: 'eth_requestAccounts' }));
  const t0 = clock.now();
  await clock.run(p.request({ method: 'personal_sign', params: [] }));
  ok('the next prompt goes at once', calls.length === 2 && clock.now() === t0);
}

console.log('\n— guarding more than once, and a provider that cannot be changed');
{
  const clock = makeClock(); let calls = 0;
  const raw = { request: async () => { calls++; return '0x1'; } };
  guardProvider(raw, { now: clock.now, sleep: clock.sleep });
  const once = raw.request;
  guardProvider(raw, { now: clock.now, sleep: clock.sleep });
  ok('a second guard changes nothing', raw.request === once);
  await clock.run(raw.request(SEND));
  ok('and a prompt reaches the wallet once', calls === 1);
  const frozen = Object.freeze({ request: async () => '0x1' });
  let threw = false, back;
  try { back = guardProvider(frozen); } catch { threw = true; }
  ok('a frozen provider is left as it is, with no error', !threw && back === frozen);
  ok('no provider, no request function: handed back', guardProvider(null) === null && guardProvider({}) !== undefined);
}

console.log('\n— what a refusal is called');
{
  ok('a person\'s no', declinedWords(rejected()) === 'Cancelled in your wallet.');
  ok('with a tail', declinedWords(rejected(), 'Nothing was sent.') === 'Cancelled in your wallet. Nothing was sent.');
  ok('no error at all reads as a cancel', declinedWords(null) === 'Cancelled in your wallet.');
  ok('a wallet that declined at once says so, keeps the tail, and says what to do',
    declinedWords({ quick: true }, 'Nothing was sent.') === 'Your wallet declined it straight away. Nothing was sent. If that was not you, close any request still open in your wallet, then press again.');
  ok('the swap wallet\'s UserStopped is as it was for a person\'s no', new UserStopped().message === 'Cancelled in your wallet. Nothing was sent.' && new UserStopped().quick === false);
  ok('and carries the flag and the words for one declined at once', new UserStopped(true).quick === true && /^Your wallet declined it straight away\. Nothing was sent\./.test(new UserStopped(true).message));
}

console.log('\n— a prompt still waiting');
{
  const clock = makeClock(), told = []; let taken = 0;
  const timers = { setTimer: (fn, ms) => { const t = { off: false }; clock.after(ms, () => { if (!t.off) fn(); }); return t; }, clearTimer: (t) => { t.off = true; } };
  const tell = () => { told.push(clock.now()); return () => { taken++; }; };
  let end = stillWaiting(tell, timers);
  await clock.run(clock.sleep(10_000)); end();
  await clock.run(clock.sleep(2 * SLOW_MS));
  ok('answered in time: nothing was said', told.length === 0 && taken === 0);
  const t0 = clock.now();
  end = stillWaiting(tell, timers);
  await clock.run(clock.sleep(SLOW_MS + 5000));
  ok(`unanswered for ${SLOW_MS / 1000} s: said once, at that time`, told.length === 1 && told[0] - t0 === SLOW_MS);
  end();
  ok('and taken back when the wallet answers', taken === 1);
  end();
  ok('ending twice takes nothing back twice', taken === 1);
}

console.log('\n— the same provider reached through two copies of the module');
{
  const copy = await import('../dapp/wallet-prompts.js?second');
  const clock = makeClock(), raw = { request: async () => '0x1' };
  guardProvider(raw, { now: clock.now, sleep: clock.sleep });
  const once = raw.request;
  copy.guardProvider(raw, { now: clock.now, sleep: clock.sleep });
  ok('the second copy leaves it as the first made it', raw.request === once);
}

console.log('\n— no page decides that a person cancelled from the words alone');
{
  const root = join(fileURLToPath(new URL('..', import.meta.url)), 'dapp');
  // the classic app (tacit.js, classic.html and what only they load), the Bitcoin pool's own page, and a page made from index.html
  const skip = /^(vendor|admin|weld|node_modules)\/|^(tacit\.js|classic\.html|tac\/index\.html|tac\/pool\.js|confidential-send-tab\.js|evm-trade-tile\.js)$/;
  const files = readdirSync(root, { recursive: true }).filter((f) => /\.(js|html)$/.test(f) && !skip.test(f.split('\\').join('/')));
  const byWords = [], unrouted = [];
  for (const f of files) {
    readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
      if (/[!=]==?\s*'Cancelled in your wallet\.?'/.test(line) && !/4001|quick/.test(line)) byWords.push(`${f}:${i + 1}`);
      if (/4001/.test(line) && /return 'Cancelled in your wallet\.'/.test(line)) unrouted.push(`${f}:${i + 1}`);
    });
  }
  ok(`no comparison with the cancel text stands without the code or the flag (${files.length} files)${byWords.length ? ': ' + byWords.join(', ') : ''}`, byWords.length === 0);
  ok(`no refusal is printed as a fixed cancel text${unrouted.length ? ': ' + unrouted.join(', ') : ''}`, unrouted.length === 0);
  // the front page's transaction prompt says it is still waiting (its code runs in the page's own module, so it is read here, not run)
  const page = readFileSync(join(root, 'index.html'), 'utf8');
  const send = page.slice(page.indexOf('async function sendTx('), page.indexOf('async function payingAccount('));
  ok('sendTx asks to be told when the wallet has not answered, and ends that when it does',
    /const waiting = stillWaiting\(/.test(send) && /eth_sendTransaction/.test(send) && /finally \{ waiting\(\); \}/.test(send));
  ok('and a toast can stay until it is taken away', /Number\.isFinite\(ms\)/.test(page) && /return \(\) => el\.remove\(\);/.test(page));
}

console.log('\n— the page\'s wallet module (dapp/evm-wallet.js), real time: a permit, then the deposit');
{
  const clock = { now: Date.now, after: (ms, fn) => setTimeout(fn, ms), at: (when, fn) => setTimeout(fn, Math.max(0, when - Date.now())) };
  const wallet = rainbowLike(clock, { think: 400, closeAfter: 300 });
  const ACCOUNT = '0x' + '5'.repeat(40);
  const control = rainbowLike(clock, { think: 400, closeAfter: 300 });
  await control.request(SIGN);
  const refusedRaw = await control.request(SEND).then(() => null, (e) => e);
  ok('control: the same wallet, called raw, refuses the deposit made at once', refusedRaw?.code === 4001);
  window.ethereum = wallet;
  const evm = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar });
  const sig = await evm.signErc2612({ token: '0x' + '2'.repeat(40), name: 'Tacit Token', owner: ACCOUNT, spender: '0x' + '3'.repeat(40), value: 10n ** 18n, nonce: 0n, deadline: 2n ** 40n });
  ok('the permit is signed through the module', sig.v >= 27 && /^0x[0-9a-f]{64}$/.test(sig.r) && /^0x[0-9a-f]{64}$/.test(sig.s));
  const t0 = Date.now();
  const hash = await evm.fundTx({ from: ACCOUNT, to: '0x' + '3'.repeat(40), data: '0x' }).then((h) => h, (e) => e);
  ok(`the deposit made at once is sent, not refused (${typeof hash === 'string' ? 'sent' : hash?.message})`, typeof hash === 'string' && hash.length === 66);
  ok('and it waited for the permit\'s window to go', Date.now() - t0 >= 900);
  delete window.ethereum;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
