// The send tab's public-payout panel (dapp/confidential-payout-panel.js) driven end to end against a hand-made DOM
// and a pool client whose relay, node and clock are doubles: a bare 0x address swaps the note-send controls for the
// payout panel, review shows the exact numbers, confirm submits with wait:false and reports "paid" only after the
// recipient's balance has risen. No jsdom, no network.
// Run: node tests/confidential-payout-panel.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { payoutPanelHtml, wirePayout } from '../dapp/confidential-payout-panel.js';
import { checksumAddress } from '../dapp/confidential-payout.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const real = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: '0x0' }), text: async () => '{}' }) });

const ETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const USDC = '0x' + 'aa'.repeat(32);
const USDC_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ROWS = [
  { ticker: 'cETH', assetId: ETH, native: true, underlying: '0x0000000000000000000000000000000000000000', unitScale: '10000000000', decimals: 18, tacitDecimals: 8 },
  { ticker: 'cUSDC', assetId: USDC, native: false, underlying: USDC_TOKEN, unitScale: '1', decimals: 6, tacitDecimals: 6 },
];
const RECIPIENT = '0x' + 'ab'.repeat(20);
const RECIPIENT_CS = checksumAddress(RECIPIENT, keccak_256);
const OWN = 'tacit1ownaddressforthetest';

// ── a DOM small enough to write by hand ──

class El {
  constructor(id) {
    Object.assign(this, { id, value: '', checked: false, disabled: false, textContent: '', innerHTML: '', style: {}, options: [], onclick: null });
    this._l = {};
  }
  addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
  dispatchEvent(ev) { for (const fn of this._l[ev.type] || []) fn(ev); return true; }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  querySelector() { return null; }
}
function makeDom() {
  const ids = new Set([...payoutPanelHtml().matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const id of ['csend-recipient', 'csend-asset', 'csend-forcewrap', 'csend-amount', 'csend-status', 'csend-note-send', 'cpay-activity']) ids.add(id);
  const map = new Map([...ids].map((id) => [id, new El(id)]));
  map.get('csend-asset').options = [{ value: ETH }, { value: USDC }, { value: '__btc__' }];
  map.get('csend-asset').value = ETH;
  return { el: (id) => map.get(id) || null, map, at: (id) => map.get(id) };
}
const type = (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); };

const note = (value, leafIndex, asset = ETH) => ({ asset, value: BigInt(value), leafIndex, cx: '0x1', cy: '0x2', owner: '0x3', secret: '0x4', blinding: '0x5', path: [], root: '0x6' });

// The pool client with fee arithmetic and the asset table from the real one; the relay, the node and the notes are doubles.
function makeWorld({ notes = [], poolStats = { totalNotesCreated: 400, outstandingNotes: 60 }, minFee = 10_000n, mergeFee = 20_000n } = {}) {
  const w = {
    notes, poolStats, minFee, mergeFee, ethBalance: 7n * 10n ** 18n, tokenBalance: 1_000n, job: { status: 'pending' }, code: '0x',
    calls: { sendUnwrap: [], transfer: [], balance: 0, status: 0 }, toasts: [], clock: 0, onSleep: null, gate: null,
    sleeps: 0, rpcFails: false,
  };
  w.ux = {
    cfg: real.cfg, assets: ROWS,
    relayFeeEligible: real.relayFeeEligible, quoteUnwrapFee: real.quoteUnwrapFee, identity: real.identity, account: real.account,
    feeUsdFor: async () => 2.5,
    quoteOpFee: async () => w.minFee,
    quoteTransferFee: async () => w.mergeFee,
    balance: async () => { w.calls.balance++; return { notes: w.notes, poolStats: w.poolStats, byAsset: {} }; },
    sendUnwrap: async (a) => {
      w.calls.sendUnwrap.push(a);
      if (w.gate) await w.gate;
      const fee = real.quoteUnwrapFee(a.amount, 'cETH', { minFee: a.feeOpts.minFee }).fee;
      return { jobId: '0xjob' + w.calls.sendUnwrap.length, status: 'pending', payout: a.amount - fee, fee };
    },
    transfer: async (a) => {
      w.calls.transfer.push(a);
      const ids = new Set(a.notes.map((n) => n.leafIndex));
      w.notes = [...w.notes.filter((n) => !ids.has(n.leafIndex)), note(a.amount, 900, a.notes[0].asset)];
      return { txHash: '0x' + 'cd'.repeat(32) };
    },
    rpc: async (m, p) => {
      if (w.rpcFails) throw new Error('rpc down');
      if (m === 'eth_getBalance') return '0x' + w.ethBalance.toString(16);
      if (m === 'eth_getCode') return w.code;
      throw new Error('unexpected rpc ' + m);
    },
    ethCall: async (to, data) => { if (String(to).toLowerCase() !== USDC_TOKEN.toLowerCase()) throw new Error('wrong token'); return '0x' + w.tokenBalance.toString(16).padStart(64, '0'); },
    relay: { status: async () => { w.calls.status++; return w.job; } },
  };
  w.now = () => w.clock;
  w.sleep = async (ms) => { w.clock += ms; w.sleeps++; if (w.onSleep) await w.onSleep(w.sleeps); };
  return w;
}

let walletCounter = 0x70;
function mount(world, { scan, wallet } = {}) {
  const dom = makeDom();
  const priv = wallet || ('0x' + (walletCounter++).toString(16).repeat(32));
  wirePayout({
    ux: world.ux, wallet: { priv }, scan: scan === undefined ? { notes: world.notes, poolStats: world.poolStats } : scan, own: OWN, keccak256: keccak_256,
    el: dom.el, toast: (m, k) => world.toasts.push([m, k]), sleep: world.sleep, now: world.now, timeoutMs: 120_000, intervalMs: 10_000,
  });
  return { dom, priv };
}
const shown = (n) => n.style.display !== 'none';
const click = async (n) => n.onclick();

// ── the recipient field decides what the tab offers ──

test('a bare 0x address swaps the note-send controls for the payout panel; anything else leaves the tab alone', () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = mount(world);
  assert.equal(shown(dom.at('cpay-panel')), false, 'hidden until an address is typed');
  assert.equal(shown(dom.at('csend-note-send')), true);
  type(dom.at('csend-recipient'), RECIPIENT);
  assert.equal(shown(dom.at('cpay-panel')), true);
  assert.equal(shown(dom.at('csend-note-send')), false, 'a 0x address cannot be a note recipient');
  for (const other of ['tacit1qqps86ymc78aa5v4q03hjlz70hrmq3a2xa4g8zg9exreekzye4h6yw4e', 'vitalik.eth', '0x02' + 'ab'.repeat(32), '0x1234', '']) {
    type(dom.at('csend-recipient'), other);
    assert.equal(shown(dom.at('cpay-panel')), false, other);
    assert.equal(shown(dom.at('csend-note-send')), true, other);
  }
});

test('an address typed before the scan finished is picked up when the panel is wired', () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const dom = makeDom();
  dom.at('csend-recipient').value = RECIPIENT;
  wirePayout({ ux: world.ux, wallet: { priv: '0x' + '71'.repeat(32) }, scan: { notes: world.notes, poolStats: world.poolStats }, own: OWN, keccak256: keccak_256, el: dom.el });
  assert.equal(shown(dom.at('cpay-panel')), true);
});

test('a mixed-case address with a bad checksum, the zero address and the pool are refused with the reason', () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = mount(world);
  const i = [...RECIPIENT_CS.slice(2)].findIndex((c) => /[a-f]/i.test(c));
  const flip = (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  const bad = '0x' + RECIPIENT_CS.slice(2, 2 + i) + flip(RECIPIENT_CS[2 + i]) + RECIPIENT_CS.slice(3 + i);
  type(dom.at('csend-recipient'), bad);
  assert.equal(shown(dom.at('cpay-panel')), true, 'still the payout path, with an error');
  assert.equal(shown(dom.at('cpay-body')), false, 'no amount entry for an address that failed');
  assert.match(dom.at('cpay-addr-note').textContent, /checksum/);
  type(dom.at('csend-recipient'), '0x' + '0'.repeat(40));
  assert.match(dom.at('cpay-addr-note').textContent, /zero address/);
  type(dom.at('csend-recipient'), world.ux.cfg.pool);
  assert.match(dom.at('cpay-addr-note').textContent, /pool contract/);
  type(dom.at('csend-recipient'), USDC_TOKEN);
  assert.match(dom.at('cpay-addr-note').textContent, /USDC token contract/, 'value sent to a token contract is lost');
  type(dom.at('csend-recipient'), RECIPIENT_CS);
  assert.equal(shown(dom.at('cpay-body')), true);
  assert.match(dom.at('cpay-addr-note').textContent, /checksum verified/);
});

// ── review ──

test('review shows the recipient, the exact amount, the quoted fee, the total debited and the plain-language privacy note', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5), note(30_000_000, 9)], poolStats: { totalNotesCreated: 400, outstandingNotes: 60 } });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  assert.match(dom.at('cpay-balance').textContent, /Shielded balance: 1\.3 ETH in 2 notes, largest 1\./);
  type(dom.at('cpay-amount'), '0.5');
  await click(dom.at('cpay-review-btn'));
  const html = dom.at('cpay-preview').innerHTML;
  assert.ok(html.includes(RECIPIENT_CS), 'the checksummed recipient');
  assert.match(html, /<b>0\.5 ETH<\/b> to/, 'exactly what was typed reaches them');
  assert.match(html, /Relay fee<\/span> 0\.0016 ETH \(about \$2\.50\), taken out of what you pay/);
  assert.match(html, /<b>0\.5016 ETH<\/b> from your shielded balance/, 'net plus fee is the total debited');
  assert.match(html, /one note of 1 ETH; the other 0\.4984 ETH comes back to you as a new hidden note/);
  assert.match(html, /relayed and gasless/);
  for (const phrase of ['hides who sent the payment', 'public on-chain', 'weak privacy', 'do not treat it as anonymous', 'does not match a recent deposit', 'wait between depositing and paying']) {
    assert.ok(html.includes(phrase), phrase);
  }
  assert.match(html, /about 60 shielded notes/);
  assert.match(html, /notes have been added to the pool since the note you would spend was created/);
  assert.match(html, /address has no checksum/, 'a lower-case address is flagged');
  assert.match(html, /cannot be undone/);
  const btn = dom.at('cpay-confirm-btn');
  assert.equal(btn.disabled, false);
  assert.equal(shown(btn), true);
  assert.match(btn.textContent, /pay 0\.5 ETH publicly/);
  assert.equal(world.calls.sendUnwrap.length, 0, 'review sends nothing');
});

test('editing anything voids the review: the confirm button goes away', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  type(dom.at('cpay-amount'), '0.5');
  await click(dom.at('cpay-review-btn'));
  assert.equal(shown(dom.at('cpay-confirm-btn')), true);
  type(dom.at('cpay-amount'), '0.6');
  assert.equal(shown(dom.at('cpay-confirm-btn')), false);
  assert.equal(dom.at('cpay-preview').innerHTML, '');
  await click(dom.at('cpay-review-btn'));
  assert.equal(shown(dom.at('cpay-confirm-btn')), true);
  type(dom.at('csend-recipient'), RECIPIENT_CS);
  assert.equal(shown(dom.at('cpay-confirm-btn')), false, 'a new address needs a new review');
});

test('a whole-note payout, a fee larger than the payment and a smart-contract recipient each get their warning', async () => {
  // A 0.10031 ETH note is exactly 0.1 ETH plus its 0.00031 fee: nothing is left over.
  let world = makeWorld({ notes: [note(10_031_000, 5)] });
  let { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  type(dom.at('cpay-amount'), '0.1');
  await click(dom.at('cpay-review-btn'));
  assert.match(dom.at('cpay-preview').innerHTML, /spends a whole note/);
  assert.match(dom.at('cpay-preview').innerHTML, /one whole note of 0\.10031 ETH/);

  world = makeWorld({ notes: [note(100_000_000, 5)], minFee: 43_000n });
  world.code = '0x6080';
  ({ dom } = mount(world));
  type(dom.at('csend-recipient'), RECIPIENT_CS);
  type(dom.at('cpay-amount'), '0.000005');
  await click(dom.at('cpay-review-btn'));
  const html = dom.at('cpay-preview').innerHTML;
  assert.match(html, /relay fee is larger than the amount/);
  assert.match(html, /smart contract/);
  assert.doesNotMatch(html, /address has no checksum/, 'a verified checksum needs no warning');
});

test('an amount with more places than the asset has, a non-number or zero is refused before anything is read', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  const before = world.calls.balance;
  for (const [v, re] of [['0.123456789', /8 decimal/], ['1e-7', /plain number/], ['abc', /plain number/], ['0', /greater than zero/], ['', /plain number/]]) {
    type(dom.at('cpay-amount'), v);
    await click(dom.at('cpay-review-btn'));
    assert.match(dom.at('cpay-status').textContent, re, JSON.stringify(v));
    assert.equal(shown(dom.at('cpay-confirm-btn')), false);
  }
  assert.equal(world.calls.balance, before, 'no rescan, no quote');
});

// ── notes that cannot cover it ──

test('with no shielded balance for the asset the panel offers to deposit first, through the existing own-address flow', async () => {
  const world = makeWorld({ notes: [note(5_000_000, 3, USDC)] });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  assert.match(dom.at('cpay-balance').textContent, /none in ETH|Shielded balance: /);
  // USDC is the held asset and sorts first; pick ETH, which is not held.
  dom.at('cpay-asset').value = ETH;
  dom.at('cpay-asset').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(shown(dom.at('cpay-deposit')), true);
  assert.equal(shown(dom.at('cpay-form')), false, 'no amount entry without a balance');
  assert.match(dom.at('cpay-deposit-text').innerHTML, /no shielded ETH/);
  assert.match(dom.at('cpay-deposit-text').innerHTML, /Deposit first/);
  assert.ok(dom.at('cpay-deposit-text').innerHTML.includes(world.ux.account('0x' + 'ee'.repeat(32)).address) === false, 'shows this wallet’s deposit address, not another');
  assert.match(dom.at('cpay-deposit-text').innerHTML, /0x[0-9a-f]{40}/, 'the account the deposit is paid from');
  assert.match(dom.at('cpay-deposit-btn').textContent, /Deposit ETH/);
  await click(dom.at('cpay-deposit-btn'));
  assert.equal(dom.at('csend-recipient').value, OWN, 'the recipient becomes the wallet’s own address');
  assert.equal(dom.at('csend-asset').value, ETH);
  assert.equal(dom.at('csend-forcewrap').checked, true, 'wrap fresh public funds');
  assert.equal(shown(dom.at('cpay-panel')), false, 'the note-send controls take over');
  assert.equal(shown(dom.at('csend-note-send')), true);
  assert.equal(dom.at('csend-amount').focused, true);
  assert.match(dom.at('csend-status').textContent, /wraps public ETH into a shielded note you hold/);
});

test('a balance that cannot cover amount plus fee says what is short and offers the deposit', async () => {
  const world = makeWorld({ notes: [note(2_000_000, 3)] });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  type(dom.at('cpay-amount'), '0.5');
  await click(dom.at('cpay-review-btn'));
  assert.equal(shown(dom.at('cpay-confirm-btn')), false);
  assert.match(dom.at('cpay-deposit-text').innerHTML, /You hold 0\.02 ETH shielded, and this payment needs 0\.5016 ETH \(0\.5 ETH to them plus a 0\.0016 ETH relay fee\)/);
  assert.equal(shown(dom.at('cpay-deposit')), true);
});

test('enough in total but spread over notes: offers a merge, runs it as a relayed self-transfer, then reviews again', async () => {
  const world = makeWorld({ notes: [note(30_000_000, 1), note(30_000_000, 2), note(30_000_000, 3)] });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  type(dom.at('cpay-amount'), '0.5');
  await click(dom.at('cpay-review-btn'));
  assert.equal(shown(dom.at('cpay-confirm-btn')), false);
  assert.equal(shown(dom.at('cpay-merge')), true);
  assert.match(dom.at('cpay-merge-text').textContent, /a payout spends one note and your largest is 0\.3 ETH/);
  assert.match(dom.at('cpay-merge-text').textContent, /lets the relay see those notes belong together/);
  assert.match(dom.at('cpay-merge-btn').textContent, /Merge 2 notes \(fee 0\.0002 ETH\)/);
  // 0.5 needs 0.5016; two 0.3 notes merge to 0.5998 which covers it.
  await click(dom.at('cpay-merge-btn'));
  assert.equal(world.calls.transfer.length, 1);
  const t = world.calls.transfer[0];
  assert.equal(t.notes.length, 2);
  assert.equal(t.recipientPubHex, real.identity(dom.priv || '0x' + (walletCounter - 1).toString(16).repeat(32)).pubHex, 'a self-transfer');
  assert.equal(t.amount, 60_000_000n - 20_000n, 'the total minus the flat fee');
  assert.equal(t.fee, 20_000n);
  assert.equal(world.calls.sendUnwrap.length, 0, 'merging pays nobody');
  assert.equal(shown(dom.at('cpay-confirm-btn')), true, 'reviewed again automatically against the merged note');
  assert.match(dom.at('cpay-preview').innerHTML, /one note of 0\.5998 ETH/);
});

test('a merge that cannot reach the need in one step says so instead of promising it', async () => {
  // Twenty 0.03 notes hold 0.6, but one merge takes at most sixteen (0.48) and 0.5016 is needed.
  const world = makeWorld({ notes: Array.from({ length: 20 }, (_, i) => note(3_000_000, i + 1)) });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  type(dom.at('cpay-amount'), '0.5');
  await click(dom.at('cpay-review-btn'));
  assert.match(dom.at('cpay-merge-btn').textContent, /Merge 16 notes/);
  assert.match(dom.at('cpay-merge-text').textContent, /still short/);
});

// ── confirm: success is the recipient's balance, nothing else ──

async function reviewed(world, amount = '0.5') {
  const m = mount(world);
  type(m.dom.at('csend-recipient'), RECIPIENT);
  type(m.dom.at('cpay-amount'), amount);
  await click(m.dom.at('cpay-review-btn'));
  return m;
}

test('confirm submits with wait:false at the reviewed gross and floor, then reports paid only after the balance rises', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom, priv } = await reviewed(world);
  const seenAtSleep = [];
  world.job = { status: 'settled', txHash: '0x' + 'ab'.repeat(32) };   // the relay claims success from the start
  world.onSleep = async (n) => {
    seenAtSleep.push(dom.at('cpay-activity').innerHTML);
    if (n === 3) world.ethBalance += 50_000_000n * 10n ** 10n;          // the payout lands at the third wait
  };
  await click(dom.at('cpay-confirm-btn'));
  assert.equal(world.calls.sendUnwrap.length, 1);
  const a = world.calls.sendUnwrap[0];
  assert.equal(a.wait, false);
  assert.equal(a.amount, 50_160_000n, 'the gross: the typed amount plus the fee');
  assert.deepEqual(a.feeOpts, { minFee: 10_000n }, 'the floor that was reviewed');
  assert.equal(a.recipient, RECIPIENT);
  assert.equal(a.note.leafIndex, 5);
  assert.equal(a.walletPriv, priv);
  assert.equal(seenAtSleep.length, 3);
  for (const html of seenAtSleep) {
    assert.doesNotMatch(html, /Paid/, 'a relay that says settled does not make it paid');
    assert.match(html, /the relay says settled/);
  }
  const done = dom.at('cpay-activity').innerHTML;
  assert.match(done, /Paid: 0\.5 ETH to /);
  assert.ok(done.includes(RECIPIENT_CS));
  assert.match(done, /balance rose by 0\.5 ETH/);
  assert.match(done, /Settle transaction/);
  assert.deepEqual(world.toasts.at(-1), [`Paid 0.5 ETH to ${RECIPIENT_CS}`, 'ok']);
  assert.equal(shown(dom.at('cpay-confirm-btn')), false, 'a confirmed plan cannot be confirmed twice');
});

// The payment is submitted without waiting, so the change note's memo is compared once the payment has landed.
test('a paid payment checks the change memo the relay shipped, and says so when it does not match', async () => {
  for (const [outcome, expected] of [['mismatch', /different memo for your change note/], ['unchecked', /could not be checked against the settle/]]) {
    const world = makeWorld({ notes: [note(100_000_000, 5)] });
    const base = world.ux.sendUnwrap;
    world.ux.sendUnwrap = async (a) => ({
      ...(await base(a)),
      verifyMemos: async () => {
        if (outcome === 'mismatch') throw new Error('settled in 0xabc, but the emitted memos differ from the sealed ones for leaf 0');
        return { memoCheck: { ok: null, reason: 'no settle tx hash — emitted memos were never checked' } };
      },
    });
    const { dom } = await reviewed(world);
    world.job = { status: 'settled', txHash: '0x' + 'ab'.repeat(32) };
    world.onSleep = async (n) => { if (n === 1) world.ethBalance += 50_000_000n * 10n ** 10n; };
    await click(dom.at('cpay-confirm-btn'));
    assert.match(dom.at('cpay-activity').innerHTML, /Paid: 0\.5 ETH to /, 'the payment itself still landed');
    const said = outcome === 'mismatch' ? world.toasts.map(([m]) => m).join(' ') : dom.at('cpay-status').textContent;
    assert.match(said, expected);
    assert.match(said, /recoverable from your wallet key/);
  }
});

test('confirm with a relay that settles but a balance that never moves ends as submitted, not yet confirmed, with the job id', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = await reviewed(world);
  world.job = { status: 'settled', txHash: '0x' + 'ab'.repeat(32) };
  await click(dom.at('cpay-confirm-btn'));
  const html = dom.at('cpay-activity').innerHTML;
  assert.match(html, /Submitted, not yet confirmed/);
  assert.match(html, /0xjob1/);
  assert.doesNotMatch(html, /Paid/);
  assert.equal(world.toasts.filter(([, k]) => k === 'ok').length, 0, 'no success toast');
  assert.equal(world.clock, 120_000, 'waited the whole window on the fake clock');
});

test('a failed relay job is reported as nothing paid', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = await reviewed(world);
  world.job = { status: 'failed', error: 'proof failed' };
  await click(dom.at('cpay-confirm-btn'));
  const html = dom.at('cpay-activity').innerHTML;
  assert.match(html, /could not settle/);
  assert.match(html, /proof failed/);
  assert.match(html, /Nothing was paid/);
  assert.doesNotMatch(html, /Paid:/);
});

test('a relay that no longer knows the job says to check the balance before retrying', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = await reviewed(world);
  world.job = { status: 'unknown' };
  await click(dom.at('cpay-confirm-btn'));
  assert.match(dom.at('cpay-activity').innerHTML, /no longer knows job 0xjob1/);
});

test('an ERC20 payout is confirmed through balanceOf, at the token’s own scale', async () => {
  const world = makeWorld({ notes: [note(50_000_000, 5, USDC)], minFee: 300_000n });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT_CS);
  assert.match(dom.at('cpay-asset').value, /^0xaa/);
  type(dom.at('cpay-amount'), '10');
  await click(dom.at('cpay-review-btn'));
  assert.match(dom.at('cpay-preview').innerHTML, /<b>10 USDC<\/b> to/);
  assert.match(dom.at('cpay-preview').innerHTML, /Relay fee<\/span> 0\.3 USDC/);
  world.onSleep = async (n) => { if (n === 1) world.tokenBalance += 10_000_000n; };
  await click(dom.at('cpay-confirm-btn'));
  assert.equal(world.calls.sendUnwrap[0].amount, 10_300_000n);
  assert.match(dom.at('cpay-activity').innerHTML, /Paid: 10 USDC/);
});

test('the fee rising between review and confirm cancels the send and shows the new numbers', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = await reviewed(world);
  assert.match(dom.at('cpay-preview').innerHTML, /Relay fee<\/span> 0\.0016 ETH/);
  world.minFee = 400_000n;
  await click(dom.at('cpay-confirm-btn'));
  assert.equal(world.calls.sendUnwrap.length, 0, 'nothing submitted at a price the payor did not see');
  assert.match(dom.at('cpay-status').textContent, /fee rose from 0\.0016 to 0\.004 ETH/);
  assert.equal(shown(dom.at('cpay-confirm-btn')), true, 'a fresh review is on screen');
  assert.match(dom.at('cpay-preview').innerHTML, /Relay fee<\/span> 0\.004 ETH/);
  assert.match(dom.at('cpay-preview').innerHTML, /<b>0\.504 ETH<\/b> from your shielded balance/);

  // A floor that moves below what the percentage already charges changes nothing, so the send goes ahead.
  const calm = makeWorld({ notes: [note(100_000_000, 5)] });
  const c = await reviewed(calm);
  calm.minFee = 60_000n;
  calm.job = { status: 'failed', error: 'stop here' };
  await click(c.dom.at('cpay-confirm-btn'));
  assert.equal(calm.calls.sendUnwrap.length, 1);
});

test('a relay that refuses the submit leaves the review in place to retry, and reports the error', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = await reviewed(world);
  world.ux.sendUnwrap = async () => { throw new Error('relay 429: free_budget'); };
  await click(dom.at('cpay-confirm-btn'));
  assert.match(dom.at('cpay-status').textContent, /Payment failed: relay 429/);
  assert.equal(dom.at('cpay-confirm-btn').disabled, false, 'can be retried');
  assert.equal(dom.at('cpay-activity').innerHTML, '', 'nothing was submitted, so no activity');
  assert.deepEqual(world.toasts.at(-1)[1], 'error');
});

test('an unreadable recipient balance stops the payment before anything is submitted', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = await reviewed(world);
  world.rpcFails = true;
  await click(dom.at('cpay-confirm-btn'));
  assert.equal(world.calls.sendUnwrap.length, 0, 'success could not be confirmed, so it is not started');
  assert.match(dom.at('cpay-status').textContent, /Payment failed: rpc down/);
});

test('a second confirm while the first is submitting does nothing', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = await reviewed(world);
  let release; world.gate = new Promise((r) => { release = r; });
  world.onSleep = async (n) => { if (n === 1) world.ethBalance += 50_000_000n * 10n ** 10n; };
  const first = click(dom.at('cpay-confirm-btn'));
  await new Promise((r) => setTimeout(r, 5));
  await click(dom.at('cpay-confirm-btn'));
  release();
  await first;
  assert.equal(world.calls.sendUnwrap.length, 1, 'one submission');
});

test('the payout line survives a re-render of the tab, and does not follow another wallet', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom, priv } = await reviewed(world);
  world.onSleep = async (n) => { if (n === 1) world.ethBalance += 50_000_000n * 10n ** 10n; };
  await click(dom.at('cpay-confirm-btn'));
  assert.match(dom.at('cpay-activity').innerHTML, /Paid/);
  const again = mount(world, { wallet: priv });
  assert.match(again.dom.at('cpay-activity').innerHTML, /Paid: 0\.5 ETH/, 'same wallet, new elements');
  const other = mount(world, { wallet: '0x' + '99'.repeat(32) });
  assert.equal(other.dom.at('cpay-activity').innerHTML, '', 'another wallet sees nothing of it');
  assert.equal(other.dom.at('cpay-activity').style.display, 'none');
});

test('the panel picker and the tab’s asset select follow each other', () => {
  const world = makeWorld({ notes: [note(100_000_000, 5), note(5_000_000, 6, USDC)] });
  const { dom } = mount(world);
  type(dom.at('csend-recipient'), RECIPIENT);
  dom.at('csend-asset').value = USDC;
  dom.at('csend-asset').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(dom.at('cpay-asset').value, USDC);
  dom.at('cpay-asset').value = ETH;
  dom.at('cpay-asset').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(dom.at('csend-asset').value, ETH);
});

test('when the initial scan failed the panel still works and reads the balance at review', async () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = mount(world, { scan: null });
  type(dom.at('csend-recipient'), RECIPIENT);
  assert.match(dom.at('cpay-balance').textContent, /Could not read your shielded balance yet/);
  assert.equal(shown(dom.at('cpay-form')), true);
  type(dom.at('cpay-amount'), '0.5');
  await click(dom.at('cpay-review-btn'));
  assert.equal(shown(dom.at('cpay-confirm-btn')), true);
  assert.match(dom.at('cpay-balance').textContent, /Shielded balance: 1 ETH in 1 note/);
});

// ── what the scan could not see ──

test('a balance from a scan that lost a channel says so, naming the channel, and still offers the form', () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const { dom } = mount(world, { scan: { notes: world.notes, poolStats: world.poolStats, diag: { errors: { cbtc: 'esplora 502' } } } });
  type(dom.at('csend-recipient'), RECIPIENT);
  const t = dom.at('cpay-balance').textContent;
  assert.match(t, /Shielded balance: 1 ETH in 1 note\./);
  assert.match(t, /Balances may be incomplete — the cBTC scan did not finish\./);
  assert.match(t, /cBTC notes are found from your key and the chain alone/);
  assert.equal(shown(dom.at('cpay-form')), true, 'a caveat is not a block');
});

test('an asset with nothing found under a failed scan is not presented as an empty balance', () => {
  const world = makeWorld({ notes: [] });
  const { dom } = mount(world, { scan: { notes: [], poolStats: world.poolStats, diag: { errors: { bridge: 'rpc timeout' } } } });
  type(dom.at('csend-recipient'), RECIPIENT);
  assert.match(dom.at('cpay-balance').textContent, /none in ETH\. Balances may be incomplete — the Bitcoin-bridge scan did not finish/);
  assert.match(dom.at('cpay-deposit-text').innerHTML, /showed up in the channels this scan could finish/);
});

test('a clean scan adds nothing to the balance line, and an inbound note is labelled on it', () => {
  const world = makeWorld({ notes: [note(100_000_000, 5)] });
  const clean = mount(world, { scan: { notes: world.notes, poolStats: world.poolStats, diag: { errors: {}, wrap: { pending: [], truncated: [] } } } });
  type(clean.dom.at('csend-recipient'), RECIPIENT);
  assert.equal(clean.dom.at('cpay-balance').textContent, 'Shielded balance: 1 ETH in 1 note.');

  const inbound = { ...note(100_000_000, 6), inboundUnverified: true };
  const marked = mount(world, { scan: { notes: [inbound], poolStats: world.poolStats, diag: { errors: {} } } });
  type(marked.dom.at('csend-recipient'), RECIPIENT);
  assert.match(marked.dom.at('cpay-balance').textContent, /1 note marked “inbound” was found from a memo addressed to you/);
});

// ── the tab itself ──

test('renderSendTab carries the panel, keeps the note-send controls, and a typed 0x address flips them', async () => {
  const prevFetch = globalThis.fetch;
  const prevDoc = globalThis.document;
  const deployBlock = real.cfg.deployBlock;
  globalThis.fetch = async (url, opts) => {
    const m = JSON.parse(opts.body).method;
    const result = m === 'eth_blockNumber' ? '0x' + (deployBlock + 5).toString(16) : m === 'eth_getLogs' ? [] : '0x';
    return { ok: true, status: 200, json: async () => ({ result }), text: async () => '{}' };
  };
  const els = new Map();
  const body = new El('csend-body');
  let html = '';
  Object.defineProperty(body, 'innerHTML', { get: () => html, set: (v) => { html = String(v); els.clear(); } });
  globalThis.document = {
    getElementById(id) {
      if (id === 'csend-body') return body;
      if (els.has(id)) return els.get(id);
      if (!html.includes(`id="${id}"`)) return null;
      const e = new El(id); els.set(id, e); return e;
    },
  };
  try {
    const { renderSendTab } = await import('../dapp/confidential-send-tab.js');
    await renderSendTab({ priv: '0x' + '7a'.repeat(32) }, {});
    for (const id of ['cpay-panel', 'cpay-activity', 'csend-note-send', 'cpay-asset', 'cpay-amount', 'cpay-review-btn', 'cpay-confirm-btn', 'cpay-merge-btn', 'cpay-deposit-btn', 'csend-review-btn', 'csend-btn']) {
      assert.ok(document.getElementById(id), `#${id} is in the tab`);
    }
    assert.match(html, /placeholder="[^"]*0x… address to pay publicly"/);
    assert.match(html, /paste it and the option to pay it publicly appears/);
    assert.equal(html.split('id="csend-note-send"').length, 2, 'one wrapper');
    // The wrapper holds the existing amount row and closes before the bridge block.
    assert.ok(html.indexOf('id="csend-note-send"') < html.indexOf('id="csend-amount"'));
    assert.ok(html.indexOf('id="csend-amount"') < html.indexOf('id="csend-preview"'));

    const d = (id) => document.getElementById(id);
    d('csend-asset').value = ETH;
    type(d('csend-recipient'), RECIPIENT);
    assert.equal(shown(d('cpay-panel')), true);
    assert.equal(shown(d('csend-note-send')), false);
    assert.equal(shown(d('cpay-deposit')), true, 'an empty pool scan: nothing to pay from yet');

    // The existing refusal is untouched for a note send that somehow reaches it.
    d('csend-amount').value = '0.1';
    await d('csend-review-btn').onclick();
    assert.match(d('csend-status').textContent, /Ethereum account address/);

    // Deposit first hands over to the own-address flow.
    await d('cpay-deposit-btn').onclick();
    const own = real.identity('0x' + '7a'.repeat(32)).pubHex;
    assert.equal(d('csend-recipient').value, own);
    assert.equal(shown(d('cpay-panel')), false);
    assert.equal(shown(d('csend-note-send')), true);
    assert.equal(d('csend-forcewrap').checked, true);
    for (const other of ['tacit1qqps86ymc78aa5v4q03hjlz70hrmq3a2xa4g8zg9exreekzye4h6yw4e', 'vitalik.eth', '0x02' + 'ab'.repeat(32)]) {
      type(d('csend-recipient'), other);
      assert.equal(shown(d('csend-note-send')), true, other);
    }
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.document = prevDoc;
  }
});
