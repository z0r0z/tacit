// dapp/swap/card.js, the parts of a press that can be read without a page: what a stopped press says it sent (an approval, or a USDT allowance reset to zero),
// that a press builds and sends with the slippage that stood when it was pressed, and that a stopped swap's deposit box can be sent back from its card.
// card.js needs a page to run, so these take the functions out of its source (the approval) and read the rest as text.
//   node --test tests/swap-card-press.test.mjs
// CARD_JS=<path> runs the same tests against another copy of card.js (the old one, to see them fail).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const card = readFileSync(process.env.CARD_JS || new URL('../dapp/swap/card.js', import.meta.url), 'utf8');
// a top-level function's source, from its signature to the closing brace at the start of a line
const fn = (name) => {
  const i = card.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(i >= 0, `${name} is in card.js`);
  const j = card.indexOf('\n}\n', i);
  return card.slice(i, j + 3);
};

// ── what a stopped press says it sent ──
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', ROUTER = '0x' + '77'.repeat(20), FROM = '0x' + '0a'.repeat(20), ONE = 10n ** 6n;
class UserStopped extends Error { constructor() { super('Cancelled'); this.userStopped = true; } }
function approval({ sends }) {
  const src = card.slice(card.indexOf('let approved = '), card.indexOf('// ── Swap privately: ETH deposited now'));
  const said = [], sent = [];
  const wallet = { sendTx: async (tx) => { sent.push(tx); return sends.shift()(); }, receipt: async () => ({ status: '0x1' }) };
  const make = new Function('wallet', 'R', 'tokenOf', 'lc', 'say', 'esc', 'tidy', 'amtFmt', 'txLink', `${src}; return { approve, unsent, state: () => ({ approved, zeroed }) };`);
  const t = { sym: 'USDT', dec: 6 };
  return { sent, said, ...make(wallet, { encApprove: (sp, a) => `approve(${a})` }, () => t, (x) => String(x).toLowerCase(), (m) => said.push(m), String, (s) => s, (v) => String(Number(v) / 1e6), (h) => h) };
}

test('a USDT allowance reset that went through and a re-approval the person declined says what was sent', async () => {
  const a = approval({ sends: [async () => '0xreset', async () => { throw new UserStopped(); }] });
  await assert.rejects(a.approve(USDT, ROUTER, 5n * ONE, FROM, 3n * ONE), (e) => e.userStopped);
  assert.strictEqual(a.sent.length, 2, 'the reset, then the approval that was declined');
  assert.strictEqual(a.unsent(), 'Your USDT allowance was set to zero; nothing else was sent.');
  assert.strictEqual(a.unsent('The price moved'), 'The price moved. Your USDT allowance was set to zero; nothing else was sent.');
});

test('a reset the person declined, and a token with no allowance to reset, sent nothing', async () => {
  const a = approval({ sends: [async () => { throw new UserStopped(); }] });
  await assert.rejects(a.approve(USDT, ROUTER, 5n * ONE, FROM, 3n * ONE), (e) => e.userStopped);
  assert.strictEqual(a.unsent(), 'Nothing was sent.');
  const b = approval({ sends: [async () => { throw new UserStopped(); }] });
  await assert.rejects(b.approve(USDT, ROUTER, 5n * ONE, FROM, 0n), (e) => e.userStopped);
  assert.strictEqual(b.sent.length, 1, 'no reset when there is nothing to reset');
  assert.strictEqual(b.unsent('This swap would fail'), 'This swap would fail, so nothing was sent.');
});

test('an approval that followed the reset is what is said, not the reset', async () => {
  const a = approval({ sends: [async () => '0xreset', async () => '0xapprove'] });
  await a.approve(USDT, ROUTER, 5n * ONE, FROM, 3n * ONE);
  assert.deepStrictEqual(a.state(), { approved: '5 USDT', zeroed: '' });
  assert.strictEqual(a.unsent(), 'Your approval of 5 USDT went through; the swap was not sent.');
});

test('every press that clears the approval it made clears the reset too', () => {
  const clears = [...card.matchAll(/approved = '';(?! zeroed)/g)];
  assert.strictEqual(clears.length, 0, 'no press clears the approval and leaves a reset from the last press to be reported as its own');
  assert.ok((card.match(/approved = ''; zeroed = '';/g) || []).length >= 3, 'go, the wallet into a private balance, and the swap to ETH from a Pay balance');
});

// ── a press is built and sent with the slippage that stood when it was pressed ──
test('go() keeps the slippage with the press and the swap is built with that, not the card\'s slippage after the awaits', () => {
  const go = fn('go'), prepare = fn('prepare');
  assert.match(go, /slip: S\.slip/, 'kept at the press');
  assert.ok(!/S\.slip/.test(prepare), 'prepare() builds with the press\'s');
  assert.ok(/P\.slip/.test(prepare));
});

test('the wallet into a private balance, the private deposit and its relayed way in, and the swap out send with the slippage pressed', () => {
  for (const [name, captures] of [['walletIntoGo', 1], ['laterGo', 1], ['laterSwap', 1]]) {
    const body = fn(name);
    assert.strictEqual((body.match(/S\.slip/g) || []).length, captures, `${name}: S.slip is read once, at the press`);
    assert.match(body, /const [^;]*\bslip = S\.slip/, `${name}: and kept`);
  }
  for (const name of ['relayStart', 'relayFund', 'relayFundRun']) assert.ok(!/S\.slip/.test(fn(name)), `${name} does not read the card's slippage`);
  assert.match(fn('relayFundRun'), /\{ from, q, v, tin, pt, fees, slip \}/, 'the relayed deposit is given the pressed slippage');
  assert.match(fn('laterGo'), /relayStart\(lt, \{[^}]*\bslip\b[^}]*\}\)/, 'and laterGo gives it');
  assert.match(fn('relayStart'), /relayFund\(lt, box, \{[^}]*\bslip\b[^}]*\}\)/);
});

// ── a stopped swap's deposit box ──
test('a stopped relayed deposit offers to send its box back only while the box holds something and its deadline has passed', () => {
  const steps = fn('paintSteps');
  const m = steps.match(/const bx = BOXES\[p\.id\], back = ([^\n]*)\n\s*\? `([^\n]*)` : '';/);
  assert.ok(m, 'the button is drawn from the box that was read');
  assert.match(m[1], /stopped && p\.boxed && p\.boxIntent/, 'a stopped relayed deposit that kept its intent');
  assert.match(m[1], /!p\.reclaimedAt/, 'not one already sent back');
  assert.match(m[1], /bx\?\.wei > 0n/, 'the box holds something');
  assert.match(m[1], /chainNow\(\) > Number\(p\.boxIntent\.deadline\)/, 'and its deadline has passed by the chain\'s clock');
  assert.match(m[2], /data-later-reclaim="\$\{id\}"/);
  assert.match(m[2], /an address only your key controls/, 'it says where the money goes');
  assert.match(m[2], /Your wallet pays the gas/, 'and who pays');
  assert.match(steps, /\$\{note\}\$\{back\}<\/section>/, 'under the note that says why it stopped');
  assert.match(steps, /p\.state === 'stopped' && p\.boxed && p\.box && p\.boxIntent && !p\.reclaimedAt && !BOXES\[p\.id\]\?\.busy/, 'what the box holds is read for it');
});

test('the press reads the plan afresh, sends from the connected wallet, tells the result, and is routed from the steps', () => {
  const go = fn('laterReclaim');
  assert.match(go, /p\.state !== 'stopped'/);
  assert.match(go, /\.reclaimBox\(p,/);
  assert.match(go, /pageSigner\.pin = W\.account/, 'the account pressed for is the account that sends');
  assert.match(go, /Sent back\./, 'the result is told');
  assert.match(go, /UserStopped/, 'and a no is not an error');
  assert.match(fn('stepsClick'), /data-later-reclaim[\s\S]*laterReclaim\(rb\.dataset\.laterReclaim\)/);
});
