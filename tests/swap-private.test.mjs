// dapp/swap/private.js: the swap card's private swap. Paid from the wallet's ETH through one pool it deposits once and the relay proves and
// settles the deposit's own swap; paid from the private balance it routes the smallest note that covers the amount, its change in the same
// proof, and combines notes too small singly. Its imports (the key
// sheet, the deposit, the relay's state, the activity journal) are stood in for here, and so is the pool module it is handed.
//   node --test tests/swap-private.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// The page imports by site path (/teth/wrap.js?cb=…): each of private.js's imports is answered by a stand-in that reads globalThis.M.
const STUBS = {
  '/trade/key.js': `export class Cancelled extends Error { constructor(m = 'Cancelled.') { super(m); this.unlockCancelled = true; } }
    export function makeKeySession() { const s = { open: false, get unlocked() { return s.open; }, get key() { return s.open ? { pubHex: '02aa' } : null; }, priv: () => new Uint8Array([1]), lock() { s.open = false; } }; globalThis.M.session = s; return s; }
    export async function signInSheet(s) { globalThis.M.sheets++; if (globalThis.M.cancel) throw new Cancelled(); s.open = true; }`,
  '/trade/poolux.js': 'export async function forgetUx() { globalThis.M.forgot++; }',
  '/teth/wrap.js': `export const wrapEth = (a) => globalThis.M.wrapEth(a);
    export const relayState = async () => globalThis.M.relay;
    export const relayStopped = (rs) => rs?.state === 'paused' || rs?.state === 'down';
    export const relayWords = (e) => 'relay: ' + (e?.message || e);
    export const wrapFirst = async () => { throw Object.assign(new Error('no proof made ahead here'), { ready: true }); };
    export const wrapCalldata = () => '0x';
    export const settle = async (a) => { globalThis.M.settled.push(a); return {}; };`,
  '/teth/read.js': 'export const WRAP_TIP = "0x000000D218B03db5837943b0b05DeA2965AE956e"; export const wrapQuote = async (wei) => { globalThis.M.quoted.push(wei); return { tip: 7n, to: "0xtip" }; };',
  '/wrap-vouchers.js': 'export function makeVouchers() { return { pick: () => null, list: () => [], drop() {}, put() {}, call: () => null }; }',
  '/activity.js': 'export function makeRunner() { return { wait: (label, ms) => ({ timeoutMs: ms, label, onJob() {} }) }; }',
  '/vendor/tacit-deps.min.js': 'export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); export const secp = {}; export const keccak_256 = () => new Uint8Array(32); export const sha256 = () => new Uint8Array(32);',
  '/confidential-stage.js': 'export const makeConfidentialStage = () => globalThis.M.stage;',
  '/confidential-secret-store.js': 'export const makeStealthSendStore = () => ({ add: async (priv, rec) => { globalThis.M.stored.push(rec); } });',
  '/confidential-names.js': `export const makeMainnetCall = () => ({});
    export const makeConfidentialNames = () => ({ decodeTacitAddress: (s) => { if (s === 'tacit1good') return { key: '02' + 'cd'.repeat(32) }; throw new Error('not a Tacit address'); },
      resolveRecipient: async (raw, { local }) => { if (/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error('That is an Ethereum account address, and a private send needs a Tacit address.'); if (raw === 'bob.wei') return { pubHex: '02' + 'ab'.repeat(32), name: 'bob.wei' }; const r = local(raw); if (r.error) throw new Error(r.error); return { pubHex: r.pubHex }; } });`,
};
const hooks = `const S = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const path = spec.split('?')[0];
  if (path in S) return { url: 'data:text/javascript,' + encodeURIComponent(S[path]), shortCircuit: true };
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const ETH = '0xeth', TAC = '0xtac';
const note = (leaf, value, asset = ETH) => ({ leaf, value: BigInt(value), asset, root: '0xroot' });

function setup({ notes = [], deposit = null, quote = 900n, quotes = null, routeErr = [], cutErr = [], fee = 20n, cutFee = 5n, submitErr = [], activation = 'done', routeOut = null, stealthErr = null, staged = null } = {}) {
  const M = globalThis.M = { sheets: 0, forgot: 0, quoted: [], relay: { state: 'ok' }, cancel: false, wraps: [], routes: [], cuts: [], reads: 0, unwraps: [], submits: [], stealths: [], stored: [], sent: [], wrapSwaps: [], wrapSwapSubmits: [], released: [], settled: [] };
  let byAsset = {};
  const put = (ns) => { byAsset = {}; for (const n of ns) { const g = (byAsset[n.asset] ||= { value: 0n, notes: [] }); g.value += n.value; g.notes.push(n); } };
  put(notes);
  M.wrapEth = async (a) => { M.wraps.push(a); a.say('sent', '0xdep'); if (deposit) setTimeout(() => put([...notes, deposit]), 0); return { hash: '0xdep', built: { leaf: deposit?.leaf, note: { asset: ETH } } }; };
  const qs = quotes ? [...quotes] : null;
  const ux = {
    balance: async () => { M.reads++; return { byAsset, diag: staged ? { wrap: { pending: [{ value: 1000n, index: 3, depositId: '0xdep' }] } } : {} }; },
    ...(staged ? { assetByTicker: { cETH: { assetId: ETH } } } : {}),
    quoteRoute: async ({ fee: f }) => ({ amountOut: qs ? qs.shift() : quote, f }),
    route: async (a) => {
      M.routes.push(a);
      const e = routeErr.shift(); if (e) throw new Error(e);
      // the route's output note: tETH, worth what the swap paid
      if (routeOut) { notes = [...notes.filter((n) => n.leaf !== a.inNote.leaf), note('0xrouted', routeOut, a.path?.length ? a.path[a.path.length - 1].assetNext : ETH)]; put(notes); }
      return { txHash: '0xswap' };
    },
    // the exit: a fee of the floor asked (or 1% if more), the rest paid to the recipient
    quoteUnwrapFee: (value, tk, { minFee }) => { const v = BigInt(value), pct = v / 100n, f = pct > minFee ? pct : minFee; return { fee: f, net: v - f }; },
    buildUnwrap: ({ note: n, recipient, feeOpts }) => { const v = BigInt(n.value), pct = v / 100n, f = pct > feeOpts.minFee ? pct : feeOpts.minFee; M.unwraps.push({ n, recipient, fee: f }); return { op: { asset: n.asset, recipient, fee: f.toString(), value: v.toString() } }; },
    cfg: { router: '0xrouter' },
    router: { escrowAddressForCalldata: (r) => 'esc:' + r.finalRecipient + ':' + r.calls[0].value + ':' + r.nonce, activateExitCalldata: () => '0xact', reclaimExitCalldata: () => '0xback' },
    ethCall: async (to, data) => '0x' + '00'.repeat(12) + 'e5c0' + '0'.repeat(36),
    relay: {
      submitOp: async (spec) => { M.submits.push(spec); const e = submitErr.shift(); if (e) throw new Error(e); return { jobId: 'job' + M.submits.length }; },
      waitForSettle: async () => ({ status: 'settled', txHash: '0xexit' }),
      status: async () => ({ activation, activateTx: activation === 'done' ? '0xactivated' : null, activateError: activation === 'failed' ? 'the fee is below the cost' : null }),
    },
    // a send to itself: the picked notes go, a note of the amount (and the change, less the fee) comes back
    transfer: async (a) => {
      M.cuts.push(a);
      const e = cutErr.shift(); if (e) throw new Error(e);
      const spent = new Set(a.notes.map((n) => n.leaf)), sum = a.notes.reduce((x, n) => x + BigInt(n.value), 0n), left = sum - BigInt(a.amount) - BigInt(a.fee);
      notes = [...notes.filter((n) => !spent.has(n.leaf)), note('0xcut', a.amount, a.notes[0].asset), ...(left > 0n ? [note('0xchange', left, a.notes[0].asset)] : [])];
      put(notes);
      return { txHash: '0xcuttx' };
    },
    identity: () => ({ pubHex: '02aa' }),
    // a stealth lock of the one note to the recipient: the note goes, nothing comes back to the balance
    stealthSend: async (a) => {
      M.stealths.push(a);
      if (stealthErr) throw new Error(stealthErr);
      notes = notes.filter((n) => !a.notes.some((m) => m.leaf === n.leaf)); put(notes);
      a.onBuilt?.({ lockLeaf: '0xlock', asset: a.notes[0].asset, amount: String(a.amount), deadline: '1900000000', lCx: '1', lCy: '2', ownerPub: '03aa', lBlinding: '3', refundPriv: '4', refundPub: '5', recipientPubHex: a.recipientPubHex });
      return { txHash: '0xlocktx' };
    },
    quoteOpFee: async (tk, kind) => (kind === 'transfer' ? cutFee : fee),
    // wallet ETH through one pool: the deposit's own swap, built at the next wrap index and settled by the relay in one step (depositSwap)
    nextWrapIndex: async () => 5,
    releaseWrapIndex: ({ index }) => { M.released.push(index); },
    buildWrapSwap: async (a) => { M.wrapSwaps.push(a); const out = qs ? qs.shift() : quote; if (out < BigInt(a.minOut)) throw new Error('wrapswap: amountOut below minOut'); return { commit: '0xc0', amountOut: out, index: a.index }; },
    submitWrapSwap: async (a) => { M.wrapSwapSubmits.push(a); const e = routeErr.shift(); if (e) throw new Error(e); return { txHash: '0xswap' }; },
    buildWrap: (a) => ({ leaf: '0xwrapleaf', commit: '0xc0', ...a }),
    ladderFee: (v) => v,
  };
  // a staged deposit of 1000 units (confidential-stage.js, stood in for): its press posts to the relay and waits, and fails as `staged` says
  if (staged) M.stage = { presses: 0, splitPending: async (p) => ({ staged: p, waiting: [] }), pressSwap: async () => { M.stage.presses++; throw staged; } };
  return { M, ux };
}
const load = async (ux) => (await import('../dapp/swap/private.js')).makePrivate({ getUx: async () => ux, pick: () => null });
const plan = (o = {}) => ({ wallet: false, units: 1000n, wei: 1000n * 10n ** 10n, asset: ETH, ticker: 'cETH', fee: 10n, path: [{ assetNext: TAC, feeBps: 30 }], minOut: 800n, label: 'Swap', ...o });
const wallet = { sendTx: async (tx) => { globalThis.M.sent.push(tx); return '0xdep'; }, receipt: async () => ({ status: '0x1' }) };
const run = (pv, p, steps = []) => pv.swap(p, { wallet, from: '0xme', say: (k) => steps.push(k) });

test('from the wallet through one pool: one deposit, and the relay proves and settles its swap in one step, with no route', async () => {
  const { M, ux } = setup({ notes: [note('0xold', 1000)] });
  const pv = await load(ux), steps = [];
  const r = await run(pv, plan({ wallet: true }), steps);
  assert.strictEqual(M.sheets, 1, 'the key sheet opened once');
  assert.deepStrictEqual(M.quoted, [1000n * 10n ** 10n], 'the relay tip is read for the deposit');
  assert.strictEqual(M.sent.length, 1);
  assert.strictEqual(M.sent[0].to.toLowerCase(), '0x000000d218b03db5837943b0b05dea2965ae956e', 'the deposit goes through the tip forwarder');
  assert.strictEqual(M.sent[0].value, 1000n * 10n ** 10n + 7n, 'the amount and the tip');
  assert.strictEqual(M.wrapSwaps[0].index, 5); assert.strictEqual(M.wrapSwaps[0].minOut, 800n); assert.strictEqual(M.wrapSwaps[0].fee, 10n); assert.strictEqual(M.wrapSwaps[0].toAsset, TAC);
  assert.strictEqual(M.wrapSwapSubmits.length, 1); assert.strictEqual(M.wrapSwapSubmits[0].waitOpts.viaRelay, true);
  assert.strictEqual(M.routes.length + M.wraps.length, 0, 'no separate wrap, no route of an old note');
  assert.deepStrictEqual({ tx: r.txHash, out: r.out }, { tx: '0xswap', out: 900n });
  assert.ok(steps.includes('sent') && steps.includes('swap'), `steps said (${steps})`);
});

test('ETH made private only: no route, the deposit is what the chain shows', async () => {
  const { M, ux } = setup({ deposit: note('0xnew', 1000) });
  const r = await run(await load(ux), plan({ wallet: true, path: [] }));
  assert.strictEqual(M.routes.length, 0);
  assert.deepStrictEqual(r, { made: 1000n, txHash: '0xdep' });
});

test('from the private balance: a note of exactly the amount is routed as it is', async () => {
  const { M, ux } = setup({ notes: [note('0xbig', 5000), note('0xexact', 1000)] });
  await run(await load(ux), plan());
  assert.strictEqual(M.wraps.length + M.cuts.length, 0, 'nothing is deposited or cut');
  assert.strictEqual(M.routes[0].inNote.leaf, '0xexact');
});

test('a larger note is spent in part by the route (the smallest that covers it), its change in the same proof, with no cut first', async () => {
  const { M, ux } = setup({ notes: [note('0xbig', 5000), note('0xsmall', 900), note('0xfit', 1200)] }), steps = [];
  await run(await load(ux), plan(), steps);
  assert.strictEqual(M.cuts.length, 0, 'no send to itself first');
  assert.strictEqual(M.routes[0].inNote.leaf, '0xfit', 'the smallest note that covers it');
  assert.strictEqual(M.routes[0].amountIn, 1000n);
  assert.ok(!steps.includes('split'));
});

test('several notes, none covering it, are combined into one of the amount; too little says how much fits', async () => {
  const a = setup({ notes: [note('0xa', 600), note('0xb', 600)] }), steps = [];
  await run(await load(a.ux), plan(), steps);
  assert.deepStrictEqual(a.M.cuts[0].notes.map((n) => n.leaf).sort(), ['0xa', '0xb']);
  assert.strictEqual(a.M.routes[0].inNote.leaf, '0xcut');
  assert.ok(steps.includes('combine'));
  const b = setup({ notes: [note('0xa', 600), note('0xb', 402)] });
  await assert.rejects(run(await load(b.ux), plan()), (e) => e.code === 'short' && e.most === 997n);
  assert.strictEqual(b.M.routes.length + b.M.cuts.length, 0);
});

test('the most one swap can spend: a lone note whole, else all of it less the fee to cut one', async () => {
  const a = setup({ notes: [note('0xa', 600)] }), pa = await load(a.ux);
  await pa.open(); assert.strictEqual(await pa.most(ETH, 'cETH'), 600n);
  const b = setup({ notes: [note('0xa', 600), note('0xb', 400)] }), pb = await load(b.ux);
  await pb.open(); assert.strictEqual(await pb.most(ETH, 'cETH'), 995n);
});

test('the relay held or paused: nothing is sent', async () => {
  for (const state of ['held', 'paused', 'down']) {
    const { M, ux } = setup({ deposit: note('0xnew', 1000) });
    M.relay = { state };
    await assert.rejects(run(await load(ux), plan({ wallet: true })), /can’t start right now/);
    assert.strictEqual(M.wraps.length + M.routes.length, 0, `${state}: no deposit, no route`);
  }
});

test('the relay’s floor moved: sent once more at its new fee, priced again', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)], routeErr: ['relay 400: fee below the current floor'], fee: 25n });
  const r = await run(await load(ux), plan());
  assert.deepStrictEqual(M.routes.map((x) => x.fee), [10n, 25n]);
  assert.strictEqual(r.txHash, '0xswap');
});

test('over two pools the new floor is the one-pool fee and 40% more, in two figures', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)], routeErr: ['fee below the current floor'], fee: 123n });
  await run(await load(ux), plan({ fee: 100n, path: [{ assetNext: ETH, feeBps: 30 }, { assetNext: TAC, feeBps: 30 }] }));
  assert.deepStrictEqual(M.routes.map((x) => x.fee), [100n, 180n]);
});

test('a price already past the quote stops before anything is sent: no deposit, no cut, no route', async () => {
  const a = setup({ notes: [note('0xbig', 5000)], quote: 700n });
  await assert.rejects(run(await load(a.ux), plan()), (e) => e.moved && !e.kept);
  assert.strictEqual(a.M.routes.length + a.M.cuts.length, 0);
  const b = setup({ deposit: note('0xnew', 1000), quote: 700n });
  await assert.rejects(run(await load(b.ux), plan({ wallet: true })), (e) => e.moved && !e.kept);
  assert.strictEqual(b.M.wraps.length + b.M.routes.length, 0, 'the ETH stays in the wallet');
});

test('a price that moved before the deposit: nothing is sent and the wrap index goes back', async () => {
  const { M, ux } = setup({ quotes: [900n, 700n] });
  await assert.rejects(run(await load(ux), plan({ wallet: true })), (e) => e.moved && /price moved/.test(e.message));
  assert.strictEqual(M.sent.length, 0, 'nothing left the wallet');
  assert.deepStrictEqual(M.released, [5]);
});

test('a swap the relay may still finish is not offered again: its note stays out of the next pick', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)], routeErr: ['settle timed out after 900s'] });
  const pv = await load(ux);
  await assert.rejects(run(pv, plan()), (e) => e.pending && /may still go through/.test(e.message) && !e.kept);
  await pv.read(true);
  assert.strictEqual(pv.of(ETH).value, 0n, 'the note in flight is not counted');
  await assert.rejects(run(pv, plan()), (e) => e.code === 'short');
  assert.strictEqual(M.routes.length, 1, 'no second route of the same note');
});

test('the deposit path: a swap the relay may still finish says so, not "press again"', async () => {
  const { ux } = setup({ deposit: note('0xnew', 1000), routeErr: ['relay 202: proved, waiting for a sender'] });
  await assert.rejects(run(await load(ux), plan({ wallet: true })), (e) => e.pending && !e.kept);
});

// ── a staged deposit's swap (confidential-stage.js): once the proof is posted the relay has the swap, and a second one is not started from a note ──
const posted = (msg) => Object.assign(new Error(msg), { jobId: 'job9' });
test('a staged swap the relay may still settle is not made again from a covering note', async () => {
  for (const msg of ['settle timed out (box offline or backlogged)', 'status polling for job job9 failed 8 times in a row (x); the job may still be running', 'relay lost the job (worker restart / KV miss)', 'settle held: proved and waiting for a sender (job job9)']) {
    const { M, ux } = setup({ notes: [note('0xn', 1000)], staged: posted(msg) });
    const pv = await load(ux);
    await assert.rejects(run(pv, plan()), (e) => e.pending && /may still go through/.test(e.message) && !e.kept, msg);
    assert.strictEqual(M.stage.presses, 1);
    assert.strictEqual(M.routes.length + M.cuts.length, 0, `${msg}: no route of a note, no cut`);
    // pressed again while the relay may still have it: the deposit is left alone
    await assert.rejects(run(pv, plan()), (e) => e.pending);
    assert.strictEqual(M.stage.presses, 1, 'the same deposit is not posted twice');
    assert.strictEqual(M.routes.length, 0);
  }
});
test('a staged swap that stopped before the proof was posted falls back to the note, as before', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)], staged: new Error('prove failed: boom') });
  const r = await run(await load(ux), plan());
  assert.strictEqual(M.stage.presses, 1);
  assert.strictEqual(M.routes.length, 1, 'the covering note is routed');
  assert.strictEqual(r.txHash, '0xswap');
});
test('a staged swap the relay says failed leaves the deposit unspent: the note may be routed', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)], staged: posted('settle failed: reserves moved') });
  await run(await load(ux), plan());
  assert.strictEqual(M.routes.length, 1);
});

test('the open key is handed to the private ETH pool as hex, opening the sheet first', async () => {
  const { M, ux } = setup();
  const pv = await load(ux);
  assert.strictEqual(await pv.keyHex(), '01');
  assert.strictEqual(M.sheets, 1);
});

test('a key sheet open once for two presses', async () => {
  const { M, ux } = setup();
  const pv = await load(ux);
  await Promise.all([pv.open(), pv.open()]);
  assert.strictEqual(M.sheets, 1);
});

test('a swap that fails after the deposit settles it as a plain wrap and says the ETH is private and kept', async () => {
  const { M, ux } = setup({ routeErr: ['prove failed: boom'] });
  await assert.rejects(run(await load(ux), plan({ wallet: true })), (e) => e.kept && /relay: prove failed: boom/.test(e.message));
  assert.strictEqual(M.wrapSwapSubmits.length, 1);
  assert.strictEqual(M.settled.length, 1, 'the same deposit settled as a wrap');
  assert.strictEqual(M.settled[0].hash, '0xdep');
});

test('a closed key sheet stops before anything is read or sent', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)] });
  M.cancel = true;
  await assert.rejects(run(await load(ux), plan()), (e) => e.unlockCancelled);
  assert.strictEqual(M.reads + M.routes.length, 0);
});

test('locking forgets the notes read and the key', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)] });
  const pv = await load(ux);
  await pv.open(); await pv.read();
  assert.strictEqual(pv.of(ETH).value, 1000n);
  pv.lock();
  assert.strictEqual(pv.held, null); assert.strictEqual(pv.unlocked, false); assert.strictEqual(M.forgot, 1);
});

// ── out of the pool, to an address ──
const ADDR = '0x00000000000000000000000000000000000a11ce', USDC = '0xusdc';
const sale = (wei, limit = 690n) => ({ callData: '0xswapcall' + String(wei), amountOut: 700n, amountLimit: limit });
const outPlan = (o = {}, out = {}) => ({ asset: '0xbtc', units: 1000n, ticker: 'cBTC', fee: 10n, eth: ETH, path: [{ assetNext: ETH, feeBps: 30 }], minOut: 400n, label: 'Out',
  out: { token: USDC, to: ADDR, minFee: 7n, min: 690n, wei: 495n * 10n ** 10n, quote: async (wei) => { globalThis.M.sales = [...(globalThis.M.sales || []), wei]; return sale(wei); }, ...out }, ...o });

test('cBTC to USDC at an address: routed to tETH, then exited through a recipe whose one call sells exactly what the escrow is paid', async () => {
  const { M, ux } = setup({ notes: [note('0xbtcnote', 1000, '0xbtc')], routeOut: 500 }), steps = [];
  const r = await (await load(ux)).swapOut(outPlan(), { say: (k) => steps.push(k) });
  assert.strictEqual(M.routes[0].inNote.leaf, '0xbtcnote'); assert.deepStrictEqual(M.routes[0].path, [{ assetNext: ETH, feeBps: 30 }]);
  const u = M.unwraps[0], sub = M.submits[0];
  assert.strictEqual(u.n.leaf, '0xrouted', 'the tETH the route made is what leaves');
  assert.strictEqual(u.fee, 7n, 'at the fee the page priced');
  const wei = (500n - 7n) * 10n ** 10n, call = sub.exit.calls[0];
  assert.deepStrictEqual(M.sales, [wei], 'the sale is priced for exactly what the unwrap pays');
  assert.strictEqual(call.target, '0x000000000000FB114709235f1ccBFfb925F600e4'); assert.strictEqual(call.value, wei.toString()); assert.strictEqual(call.data, '0xswapcall' + wei);
  assert.strictEqual(call.token, '0x0000000000000000000000000000000000000000'); assert.strictEqual(call.push, false);
  assert.strictEqual(sub.exit.finalRecipient, ADDR); assert.strictEqual(sub.exit.exitedAsset, ETH);
  assert.deepStrictEqual(sub.exit.sweepTokens, ['0x0000000000000000000000000000000000000000']);
  assert.strictEqual(sub.type, 'unwrap'); assert.strictEqual(sub.op.recipient, u.recipient);
  assert.ok(/^0x0{24}e5c0/.test('0x' + '0'.repeat(24) + u.recipient.slice(2)) && u.recipient === '0x' + 'e5c0' + '0'.repeat(36), `the unwrap pays the escrow the router named (${u.recipient})`);
  assert.ok(Number(sub.exit.deadline) > Date.now() / 1000 + 1700, 'the recipe runs for half an hour');
  assert.deepStrictEqual({ tx: r.txHash, out: r.out, to: r.to }, { tx: '0xactivated', out: 700n, to: ADDR });
  assert.deepStrictEqual(steps, ['route', 'note', 'exitswap', 'activate']);
});

test('an exit recipe runs from the chain’s clock, not a device clock that is behind', async () => {
  const { M, ux } = setup({ notes: [note('0xbtcnote', 1000, '0xbtc')], routeOut: 500 });
  const chainNow = Date.now() + 3 * 3600e3;
  await (await import('../dapp/swap/private.js')).makePrivate({ getUx: async () => ux, pick: () => null, now: () => chainNow }).swapOut(outPlan());
  assert.strictEqual(M.submits[0].exit.deadline, String(Math.floor(chainNow / 1000) + 1800));
});

test('tETH to ETH at an address: a plain unwrap to it, no recipe', async () => {
  const { M, ux } = setup({ notes: [note('0xt', 1000)] });
  const r = await (await load(ux)).swapOut(outPlan({ asset: ETH, path: [] }, { token: null, minFee: 9n }));
  assert.strictEqual(M.routes.length, 0);
  assert.strictEqual(M.unwraps[0].recipient, ADDR); assert.strictEqual(M.submits[0].exit, undefined);
  assert.deepStrictEqual({ tx: r.txHash, out: r.out }, { tx: '0xexit', out: (1000n - 10n) * 10n ** 10n });
});

test('a sale under the floor the quote promised (scaled to what the note pays) does not leave the pool: the tETH stays private', async () => {
  const { M, ux } = setup({ notes: [note('0xbtcnote', 1000, '0xbtc')], routeOut: 500 });
  const pv = await load(ux);
  await assert.rejects(pv.swapOut(outPlan({}, { quote: async (wei) => sale(wei, 600n) })), (e) => e.kept && /privately to tETH/.test(e.message) && /price moved/.test(e.message));
  assert.strictEqual(M.submits.length, 0, 'no exit was sent');
  const b = setup({ notes: [note('0xt', 1000)] });
  await assert.rejects((await load(b.ux)).swapOut(outPlan({ asset: ETH, path: [] }, { quote: async (wei) => sale(wei, 1n) })), (e) => e.moved && !e.kept);
});

test('the relay refuses to run the swap: the exit is stuck at its escrow and says so, with its recipe', async () => {
  const { ux } = setup({ notes: [note('0xt', 1000)], activation: 'failed' });
  await assert.rejects((await load(ux)).swapOut(outPlan({ asset: ETH, path: [] }, { wei: 990n * 10n ** 10n })), (e) => e.stuck && e.stuck.recipe.finalRecipient === ADDR && e.stuck.escrow && /below the cost/.test(e.stuck.why));
});

test('the relay’s floor moved before it took the exit: priced again, a new recipe at the higher fee', async () => {
  const { M, ux } = setup({ notes: [note('0xt', 1000)], submitErr: ['relay 400: fee below the current floor'] });
  await (await load(ux)).swapOut(outPlan({ asset: ETH, path: [] }, { wei: 990n * 10n ** 10n }));
  assert.strictEqual(M.submits.length, 2);
  assert.deepStrictEqual(M.unwraps.map((u) => u.fee), [10n, 14n], 'the 1% fee first, then twice the floor asked');
  assert.notStrictEqual(M.submits[0].exit.calls[0].value, M.submits[1].exit.calls[0].value, 'the second recipe sells what the higher fee leaves');
});

test('an exit the relay refuses after the route: the tETH stays private and the card can send it on', async () => {
  const { ux } = setup({ notes: [note('0xbtcnote', 1000, '0xbtc')], routeOut: 500, submitErr: ['relay 400: no'] });
  await assert.rejects((await load(ux)).swapOut(outPlan()), (e) => e.kept && /did not leave the pool/.test(e.message));
});

test('the calls a wallet can send for a stuck exit: the swap, or the ETH on to the address', async () => {
  const { ux } = setup();
  assert.deepStrictEqual(await (await load(ux)).exitCalls({}), { router: '0xrouter', activate: '0xact', reclaim: '0xback' });
});

// ── to another Tacit address ──
const BOB = { pubHex: '02' + 'ab'.repeat(32), name: 'bob.wei' };
test('a Tacit address or a name resolves to its key; an Ethereum account address and a stranger are refused in words', async () => {
  const { resolveTacit } = await import('../dapp/swap/private.js');
  assert.deepStrictEqual(await resolveTacit(' bob.wei '), BOB);
  assert.strictEqual((await resolveTacit('tacit1good')).pubHex, '02' + 'cd'.repeat(32));
  await assert.rejects(resolveTacit('0x' + '11'.repeat(20)), /needs a Tacit address/);
  await assert.rejects(resolveTacit('nonsense'), /not a Tacit address/);
});

test('a swap made to a Tacit address: routed, the new note found, locked for them, the lock kept', async () => {
  const { M, ux } = setup({ notes: [note('0xin', 1000)], routeOut: 880 });
  const steps = [], r = await (await load(ux)).swap(plan({ sendTo: BOB, outTicker: 'cTAC', path: [{ assetNext: TAC, feeBps: 30 }], minOut: 800n }), { wallet: {}, from: '0xme', say: (k) => steps.push(k) });
  assert.strictEqual(M.routes.length, 1); assert.strictEqual(M.stealths.length, 1);
  assert.strictEqual(M.stealths[0].recipientPubHex, BOB.pubHex); assert.strictEqual(M.stealths[0].amount, 880n);
  assert.strictEqual(M.stealths[0].notes[0].leaf, '0xrouted', 'the note the swap made is the one sent');
  assert.deepStrictEqual(r.sent, { to: 'bob.wei', txHash: '0xlocktx' });
  assert.strictEqual(M.stored[0].recipientName, 'bob.wei'); assert.strictEqual(M.stored[0].ticker, 'cTAC', 'the lock is kept under the asset that was sent');
  assert.deepStrictEqual(steps.filter((k) => ['route', 'note', 'send'].includes(k)), ['route', 'note', 'send']);
});

test('wallet ETH made private and sent on: the deposit note itself is locked for them, no route', async () => {
  const { M, ux } = setup({ deposit: note('0xnew', 1000) });
  const r = await (await load(ux)).swap(plan({ wallet: true, path: [], sendTo: BOB, outTicker: 'cETH' }), { wallet: {}, from: '0xme' });
  assert.strictEqual(M.routes.length, 0); assert.strictEqual(M.stealths[0].notes[0].leaf, '0xnew'); assert.strictEqual(r.sent.to, 'bob.wei');
});

test('your own address is refused before anything is sent', async () => {
  const { M, ux } = setup({ notes: [note('0xin', 1000)], routeOut: 880 });
  await assert.rejects((await load(ux)).swap(plan({ sendTo: { pubHex: '02aa', name: null } }), { wallet: {}, from: '0xme' }), /your own address/);
  assert.strictEqual(M.routes.length + M.stealths.length + M.wraps.length, 0);
});

test('a send that stops after the swap says the swap is done and the note is in the balance', async () => {
  const { M, ux } = setup({ notes: [note('0xin', 1000)], routeOut: 880, stealthErr: 'relay 400: fee below the current floor' });
  await assert.rejects((await load(ux)).swap(plan({ sendTo: BOB, path: [{ assetNext: TAC, feeBps: 30 }], minOut: 800n }), { wallet: {}, from: '0xme' }), (e) => e.stayed && /in your private balance, but it was not sent on/.test(e.message) && e.made.txHash === '0xswap');
  assert.strictEqual(M.stored.length, 0, 'no lock is kept for a payment that was not made');
});

test('a swap with no recipient sends nothing on', async () => {
  const { M, ux } = setup({ notes: [note('0xin', 1000)], routeOut: 880 });
  const r = await (await load(ux)).swap(plan({ path: [{ assetNext: TAC, feeBps: 30 }], minOut: 800n }), { wallet: {}, from: '0xme' });
  assert.strictEqual(M.stealths.length, 0); assert.strictEqual(r.sent, undefined);
});
