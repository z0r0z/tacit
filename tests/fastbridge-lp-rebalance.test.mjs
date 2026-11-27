// The provider's rebalancing (fastbridge-lp/lib/rebalance.mjs): when to swap, which venue, and that nothing is sent to an address the nodes do not agree on.
//   node tests/fastbridge-lp-rebalance.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const S = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { rebalanceConfig, planRebalance, venueQuote, bestQuote, costBps, makeRebalancer } = await import(`${S}/fastbridge-lp/lib/rebalance.mjs`);

const ETH = (n) => BigInt(Math.round(n * 1e8)) * 10n ** 10n;
const cfg = (env = {}) => rebalanceConfig({ FB_LP_REBALANCE: 'on', FB_LP_REBALANCE_CONFIRM_LOOKS: '1', ...env });
const MARKET = 36;                                              // ETH per BTC
const BTC_DEST = 'bc1qvufjyer5us77xfkvzu9zjm8gf2ws2m389xtm8e', ETH_DEST = '0x3af0145ffd8bf91e2072ab1a23ecba7dcb0a6c7b';
const VAULT = '0x' + 'ab'.repeat(20);

test('the settings: off unless set, a bad value stops the start, the swap limits are kept in order', () => {
  assert.equal(rebalanceConfig({}).mode, 'off');
  assert.equal(rebalanceConfig({ FB_LP_REBALANCE: 'dry' }).mode, 'dry');
  assert.throws(() => rebalanceConfig({ FB_LP_REBALANCE: 'yes' }), /on, dry or off/);
  assert.throws(() => rebalanceConfig({ FB_LP_REBALANCE_VENUES: 'uniswap' }), /unknown venue/);
  assert.throws(() => rebalanceConfig({ FB_LP_REBALANCE_MIN_ETH: '0.5', FB_LP_REBALANCE_MAX_ETH: '0.3' }), /MIN_ETH/);
  assert.throws(() => rebalanceConfig({ FB_LP_REBALANCE_NODES_THORCHAIN: 'http://insecure.example' }), /https/);
});

test('the plan: in band nothing, a surplus is cut to the least, the most and the day\'s room; a small one waits', () => {
  const c = cfg();
  const sats = (eth) => Math.round(eth / MARKET * 1e8);
  assert.equal(planRebalance({ ethWei: ETH(5), sats: sats(5), ethPerBtc: MARKET, cfg: c }), null, 'half and half');
  assert.equal(planRebalance({ ethWei: ETH(6), sats: sats(4), ethPerBtc: MARKET, cfg: c }), null, '60/40 is inside the band');
  const heavy = planRebalance({ ethWei: ETH(8), sats: sats(2), ethPerBtc: MARKET, cfg: c });
  assert.equal(heavy.dir, 'eth2btc'); assert.equal(heavy.amountWei, ETH(0.3), 'capped at the most in one swap');
  const day = planRebalance({ ethWei: ETH(8), sats: sats(2), ethPerBtc: MARKET, cfg: c, movedTodayWei: ETH(0.5) });
  assert.match(day.skip, /day's limit/, 'room left under the least: wait for tomorrow');
  const small = planRebalance({ ethWei: ETH(0.5), sats: sats(0.25), ethPerBtc: MARKET, cfg: c });
  assert.match(small.skip, /under the least/, 'a surplus of 0.125 ETH is not worth a swap\'s fixed fee');
  const btc = planRebalance({ ethWei: ETH(1), sats: sats(9), ethPerBtc: MARKET, cfg: c });
  assert.equal(btc.dir, 'btc2eth'); assert.ok(btc.amountSats > 0n);
  assert.match(planRebalance({ ethWei: 1n, sats: 1, ethPerBtc: 0, cfg: c }).skip, /market/);
});

// a venue's nodes, stood in for: `books` is each node's inbound addresses; the quote is the same for all
function venueFetch({ books, quote, calls = [] }) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const node = [...books.keys()].find((n) => url.startsWith(n));
    if (!node) throw new Error('unreachable');
    const b = books.get(node);
    if (b === null) throw new Error('down');
    const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
    if (u.pathname.endsWith('/inbound_addresses')) return json(b);
    if (u.pathname.endsWith('/quote/swap')) return json(typeof quote === 'function' ? quote(u.searchParams) : quote);
    return json({}, 404);
  };
}
const book = (over = {}) => [{ chain: 'ETH', address: VAULT, router: '0x' + '11'.repeat(20), halted: false, ...over.ETH }, { chain: 'BTC', address: 'bc1qvault', halted: false, ...over.BTC }];
const quoteOf = (over = {}) => (q) => ({ inbound_address: VAULT, memo: `=:b:${q.get('destination')}`, expected_amount_out: '800000', expiry: 2_000_000_100, ...over });
const NOW = () => 2_000_000_000;

test('a venue quote is taken only when two nodes agree on the vault, trading is open, and the memo is a plain swap to the provider\'s own address', async () => {
  const args = { venue: 'mayachain', from: 'ETH', to: 'BTC', amount: '5000000', destination: BTC_DEST, slipBps: 100, now: NOW };
  const nodes = ['https://a.example', 'https://b.example'];
  const ok = await venueQuote({ ...args, nodes, fetchImpl: venueFetch({ books: new Map([[nodes[0], book()], [nodes[1], book()]]), quote: quoteOf() }) });
  assert.equal(ok.vault, VAULT); assert.equal(ok.out, 800000n);
  const bad = (books, quote, re) => assert.rejects(() => venueQuote({ ...args, nodes, fetchImpl: venueFetch({ books: new Map(books), quote }) }), re);
  await bad([[nodes[0], book()], [nodes[1], null]], quoteOf(), /only 1 node/);
  await bad([[nodes[0], book()], [nodes[1], book({ ETH: { address: '0x' + 'cd'.repeat(20) } })]], quoteOf(), /disagree/);
  await bad([[nodes[0], book({ BTC: { halted: true } })], [nodes[1], book()]], quoteOf(), /halted/);
  await bad([[nodes[0], book({ ETH: { chain_trading_paused: true } })], [nodes[1], book()]], quoteOf(), /halted/);
  await bad([[nodes[0], book()], [nodes[1], book()]], quoteOf({ inbound_address: '0x' + 'ee'.repeat(20) }), /vault address/);
  await bad([[nodes[0], book()], [nodes[1], book()]], (q) => ({ ...quoteOf()(q), memo: '=:b:bc1qsomeoneelse' }), /memo/);
  await bad([[nodes[0], book()], [nodes[1], book()]], (q) => ({ ...quoteOf()(q), memo: `=:b:${q.get('destination')}:0/1/0:attacker:50` }), /memo/);
  await bad([[nodes[0], book()], [nodes[1], book()]], quoteOf({ expiry: 2_000_000_030 }), /expire/);
  await bad([[nodes[0], book()], [nodes[1], book()]], quoteOf({ expected_amount_out: '0' }), /nothing out/);
  await bad([[nodes[0], book()], [nodes[1], book()]], quoteOf({ recommended_min_amount_in: '9000000' }), /least/);
});

test('with Ethereum vouching for the vault (its router has paid out of it lately), one node is enough; a router that is not the pinned one, or a vault with no history, is refused', async () => {
  const MAYA_ROUTER = '0xe3985E6b61b814F7Cdb188766562ba71b446B46d';
  const args = { venue: 'mayachain', from: 'ETH', to: 'BTC', amount: '5000000', destination: BTC_DEST, slipBps: 100, now: NOW };
  const nodes = ['https://a.example', 'https://b.example'];
  const one = (over, quote = quoteOf()) => venueFetch({ books: new Map([[nodes[0], book({ ETH: { router: MAYA_ROUTER, ...over } })], [nodes[1], null]]), quote });
  const seenArgs = [];
  const ok = await venueQuote({ ...args, nodes, fetchImpl: one({}), vaultHistory: async (x) => { seenArgs.push(x); return 12; } });
  assert.equal(ok.vault, VAULT); assert.equal(seenArgs[0].router, MAYA_ROUTER, 'the router asked about is the pinned one, not the node\'s');
  await assert.rejects(() => venueQuote({ ...args, nodes, fetchImpl: one({ router: '0x' + '22'.repeat(20) }), vaultHistory: async () => 12 }), /not the one this provider knows/);
  await assert.rejects(() => venueQuote({ ...args, nodes, fetchImpl: one({}), vaultHistory: async () => 1 }), /no recent outbound payments/);
  await assert.rejects(() => venueQuote({ ...args, nodes, fetchImpl: one({}) }), /only 1 node/, 'with nothing to vouch for the vault, two nodes must agree as before');
  const two = new Map([[nodes[0], book({ ETH: { router: MAYA_ROUTER } })], [nodes[1], book({ ETH: { router: MAYA_ROUTER, address: '0x' + 'cd'.repeat(20) } })]]);
  await assert.rejects(() => venueQuote({ ...args, nodes, fetchImpl: venueFetch({ books: two, quote: quoteOf() }), vaultHistory: async () => 12 }), /disagree/, 'two nodes that differ are still refused');
});

test('the best venue is the cheaper one; one that is halted or disagrees is left out and the other is used', async () => {
  const c = cfg({ FB_LP_REBALANCE_NODES_THORCHAIN: 'https://t1.example,https://t2.example', FB_LP_REBALANCE_NODES_MAYACHAIN: 'https://m1.example,https://m2.example' });
  const amountWei = ETH(0.3), out = { thorchain: '830000', mayachain: '845000' };
  const fetchImpl = async (url) => {
    const v = url.includes('t1') || url.includes('t2') ? 'thorchain' : 'mayachain';
    const path = new URL(url).pathname;
    const j = (x) => ({ ok: true, status: 200, json: async () => x });
    if (path.endsWith('/inbound_addresses')) return j(book());
    return j(quoteOf({ expected_amount_out: out[v] })(new URL(url).searchParams));
  };
  const r = await bestQuote({ cfg: c, fetchImpl, dir: 'eth2btc', amount1e8: String(amountWei / 10n ** 10n), destination: BTC_DEST, ethPerBtc: MARKET, amountWei });
  assert.equal(r.best.venue, 'mayachain'); assert.equal(r.all.length, 2);
  const onlyT = await bestQuote({ cfg: { ...c, venues: ['thorchain', 'mayachain'] }, fetchImpl: async (u) => { if (/m[12]\.example/.test(u)) throw new Error('down'); return fetchImpl(u); }, dir: 'eth2btc', amount1e8: '30000000', destination: BTC_DEST, ethPerBtc: MARKET, amountWei });
  assert.equal(onlyT.best.venue, 'thorchain'); assert.equal(onlyT.why.length, 1);
});

test('cost is what is sold against what comes back at the market', () => {
  assert.equal(costBps({ dir: 'eth2btc', amountWei: ETH(0.36), out: 1_000_000n, ethPerBtc: 36 }), 0, '0.36 ETH is 0.01 BTC');
  assert.equal(costBps({ dir: 'eth2btc', amountWei: ETH(0.36), out: 990_000n, ethPerBtc: 36 }), 100);
  assert.equal(costBps({ dir: 'btc2eth', amountSats: 1_000_000n, out: 35_640_000n, ethPerBtc: 36 }), 100);
});

// the machine, with its dependencies stood in for
function world({ mode = 'on', publicWei = ETH(0.1), inv = { ethWei: ETH(8), sats: Math.round(2 / MARKET * 1e8) }, quoteOut = '828000', kept = null, quiet = true, mined = true } = {}) {
  const w = { publicWei, sent: [], unshields: [], alerts: [], store: kept, nonce: 5, clock: 2_000_000_000 };
  const books = new Map([['https://a.example', book()], ['https://b.example', book()]]);
  const c = cfg({ FB_LP_REBALANCE: mode, FB_LP_REBALANCE_VENUES: 'mayachain', FB_LP_REBALANCE_NODES_MAYACHAIN: 'https://a.example,https://b.example' });
  const fetchImpl = venueFetch({ books, quote: (q) => quoteOf({ expected_amount_out: w.quoteOut ?? quoteOut, expiry: w.clock + 600 })(q) });
  w.quoteOut = quoteOut;
  const build = () => makeRebalancer({
    cfg: c, rate: async () => MARKET, inventory: async () => inv, quiet: async () => quiet, fetchImpl, now: () => w.clock,
    unshield: async ({ units }) => { w.unshields.push(units); },
    ethBalance: async () => w.publicWei, ethNonce: async () => w.nonce, ethReceipt: async () => (mined ? { status: '0x1' } : null),
    sendEth: async (x) => { w.sent.push(x); w.nonce += 1; return '0x' + 'f1'.repeat(32); },
    address: ETH_DEST, btcDestination: BTC_DEST, gasReserveWei: ETH(0.02),
    load: async () => w.store, save: async (r) => { w.store = JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? String(v) : v))); },
    log: () => {}, alert: (a) => w.alerts.push(a),
  });
  w.r = build(); w.build = build;
  return w;
}

test('a look that cannot read the market says so in info, and sends nothing', async () => {
  const w = world({ publicWei: ETH(1) });
  const r = makeRebalancer({ cfg: cfg({ FB_LP_REBALANCE: 'on' }), rate: async () => ({ num: 1n, den: 2n }), inventory: async () => ({ ethWei: ETH(8), sats: 5e6 }), ethBalance: async () => ETH(1), ethNonce: async () => 1, ethReceipt: async () => null, sendEth: async () => { throw new Error('no'); }, address: ETH_DEST, btcDestination: BTC_DEST, gasReserveWei: ETH(0.02), load: async () => null, save: async () => {}, now: () => w.clock });
  assert.equal((await r.step()).did, 'unread');
  assert.match(r.info().last.plan, /no market price/);
});

test('off sends nothing, a dry run says what it would do and sends nothing', async () => {
  const off = world({ mode: 'off' });
  assert.equal((await off.r.step()).did, 'off');
  const dry = world({ mode: 'dry', publicWei: ETH(1) });
  assert.equal((await dry.r.step()).did, 'dry');
  assert.equal(dry.sent.length, 0); assert.equal(dry.unshields.length, 0);
  assert.ok(dry.alerts.some((a) => /dry run/.test(a.msg)));
});

test('with the public ETH there, one swap goes to the venue\'s vault with the memo, is counted once, and the next look does not repeat it', async () => {
  const w = world({ publicWei: ETH(1) });
  const a = await w.r.step();
  assert.equal(a.did, 'sent');
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].to, VAULT); assert.equal(w.sent[0].value, ETH(0.3)); assert.equal(w.sent[0].memo, `=:b:${BTC_DEST}`);
  assert.equal(w.store.moved, String(ETH(0.3)));
  assert.equal((await w.r.step()).did, 'swapped', 'mined: the swap is closed');
  w.clock += 5000;
  const again = await w.r.step();
  assert.ok(w.sent.length === 1 || again.did === 'sent', 'a second swap only if the sides are still out of band and the day has room');
  assert.ok(BigInt(w.store.moved) <= ETH(0.6), 'never past the day\'s limit');
});

test('short of public ETH it unshields first, holds the shield off while it waits, and sends once the ETH has arrived', async () => {
  const w = world({ publicWei: ETH(0.05) });
  assert.equal((await w.r.step()).did, 'unshielding');
  assert.equal(w.unshields.length, 1);
  const want = (ETH(0.3) + ETH(0.02) - ETH(0.05)) / 10n ** 10n;
  assert.ok(w.unshields[0] >= want && w.unshields[0] <= want + 60000n, `asked for the shortfall and the relay's fee (${w.unshields[0]} vs ${want})`);
  assert.equal(w.r.holding(), true);
  assert.equal((await w.r.step()).did, 'waiting for the unshield');
  assert.equal(w.sent.length, 0);
  w.publicWei = ETH(0.4);
  assert.equal((await w.r.step()).did, 'sent');
  assert.equal(w.unshields.length, 1, 'unshielded once');
});

test('a quote over the cost limit is not taken; a swap busy with others, or a restart after a send that may have gone out, does not send twice', async () => {
  const dear = world({ publicWei: ETH(1), quoteOut: '700000' });
  assert.equal((await dear.r.step()).did, 'dear');
  assert.equal(dear.sent.length, 0);
  const busy = world({ publicWei: ETH(1), quiet: false });
  assert.equal((await busy.r.step()).did, 'quiet');
  assert.equal(busy.store, null, 'nothing was started');
  // killed after the stage was kept and before the send was known: the account's nonce says whether it went
  const w = world({ publicWei: ETH(1) });
  w.store = { v: 1, moved: '0', day: Math.floor(w.clock / 86400), pending: { id: 'x', dir: 'eth2btc', stage: 'sending', amountWei: String(ETH(0.3)), targetPublic: String(ETH(0.32)), at: w.clock, nonce: 4 }, done: 0 };
  w.nonce = 5;
  const r = w.build();
  assert.equal((await r.step()).did, 'halted');
  assert.ok(w.alerts.some((a) => /may have been sent/.test(a.msg)));
  assert.equal(w.sent.length, 0);
  const w2 = world({ publicWei: ETH(1) });
  w2.store = { v: 1, moved: '0', day: Math.floor(w2.clock / 86400), pending: { id: 'x', dir: 'eth2btc', stage: 'sending', amountWei: String(ETH(0.3)), targetPublic: String(ETH(0.32)), at: w2.clock, nonce: 5 }, done: 0 };
  assert.equal((await w2.build().step()).did, 'cleared', 'the nonce has not moved: it did not go');
});

// the Bitcoin leg: sats sold for ETH, the ETH landing at the provider's own pool account
const BTC_VAULT = 'bc1q' + 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
function btcWorld({ mode = 'on', history = 9, kept = null, broadcastFails = null, confs = 0 } = {}) {
  const w = { built: 0, broadcast: [], alerts: [], store: kept, clock: 2_000_000_000, confs };
  const books = new Map([['https://a.example', [{ chain: 'ETH', address: VAULT, halted: false }, { chain: 'BTC', address: BTC_VAULT, halted: false }]], ['https://b.example', null]]);
  const c = cfg({ FB_LP_REBALANCE: mode, FB_LP_REBALANCE_VENUES: 'mayachain', FB_LP_REBALANCE_NODES_MAYACHAIN: 'https://a.example,https://b.example' });
  const fetchImpl = venueFetch({ books, quote: (q) => ({ inbound_address: BTC_VAULT, memo: `=:e:${q.get('destination')}`, expected_amount_out: '29800000', expiry: w.clock + 600 }) });
  const build = () => makeRebalancer({
    cfg: c, rate: async () => MARKET, inventory: async () => ({ ethWei: ETH(1), sats: 4e7 }), fetchImpl, now: () => w.clock,
    vaultHistory: async ({ chain }) => (chain === 'BTC' ? history : 0),
    btcBuild: async ({ to, sats, memo }) => { w.built++; w.last = { to, sats, memo }; return { txid: 'ab'.repeat(32), hex: '02000000deadbeef', fee: 400 }; },
    btcBroadcast: async (h) => { if (broadcastFails) throw new Error(broadcastFails); w.broadcast.push(h); },
    btcStatus: async () => ({ confirmations: w.confs }),
    ethBalance: async () => ETH(0.1), ethNonce: async () => 1, ethReceipt: async () => null, sendEth: async () => { throw new Error('no eth send in this direction'); },
    address: ETH_DEST, btcDestination: BTC_DEST, gasReserveWei: ETH(0.02), quiet: async () => true,
    load: async () => w.store, save: async (r) => { w.store = JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? String(v) : v))); },
    log: () => {}, alert: (a) => w.alerts.push(a),
  });
  w.r = build(); w.build = build;
  return w;
}

test('BTC-heavy: the sats are built, kept, sent to the vault with a memo naming the provider\'s own account, counted once, and closed when confirmed', async () => {
  const w = btcWorld();
  const a = await w.r.step();
  assert.equal(a.did, 'sent');
  assert.equal(w.built, 1); assert.equal(w.broadcast.length, 1);
  assert.equal(w.last.to, BTC_VAULT); assert.equal(w.last.memo, `=:e:${ETH_DEST}`);
  assert.ok(w.last.sats > 0n && BigInt(w.store.moved) > 0n, 'counted against the day');
  assert.equal(w.store.pending.stage, 'sent');
  assert.equal((await w.r.step()).did, 'pending', 'not confirmed yet');
  assert.equal(w.broadcast.length, 1, 'never sent twice');
  w.confs = 1;
  assert.equal((await w.r.step()).did, 'swapped');
  assert.equal(w.store.pending, null);
  assert.equal(w.r.holding(), false, 'the ETH shield is not held for this direction');
});

test('the Bitcoin leg: a dry run builds nothing; a vault with no history is refused; a restart in the middle sends the same bytes again, not a new payment', async () => {
  const dry = btcWorld({ mode: 'dry' });
  assert.equal((await dry.r.step()).did, 'dry'); assert.equal(dry.built, 0); assert.equal(dry.broadcast.length, 0);
  const none = btcWorld({ history: 0 });
  assert.equal((await none.r.step()).did, 'no quote'); assert.equal(none.built, 0);
  const w = btcWorld({ broadcastFails: 'explorer down' });
  assert.equal((await w.r.step()).did, 'failed');
  assert.equal(w.store.pending.stage, 'sending', 'kept before it was sent');
  const again = btcWorld({ kept: w.store });
  const r = again.build();
  assert.equal((await r.step()).did, 'sent');
  assert.equal(again.built, 0, 'not built a second time');
  assert.deepEqual(again.broadcast, ['02000000deadbeef'], 'the same transaction');
});

test('a swap is made only when two looks in a row call for it: one odd reading of the balance is not acted on', async () => {
  const w = btcWorld();
  const c2 = rebalanceConfig({ FB_LP_REBALANCE: 'on', FB_LP_REBALANCE_VENUES: 'mayachain', FB_LP_REBALANCE_NODES_MAYACHAIN: 'https://a.example,https://b.example' });
  assert.equal(c2.confirmLooks, 2);
  let sats = 4e7, built = 0;
  const books = new Map([['https://a.example', [{ chain: 'ETH', address: VAULT, halted: false }, { chain: 'BTC', address: BTC_VAULT, halted: false }]], ['https://b.example', null]]);
  const fetchImpl = venueFetch({ books, quote: (q) => ({ inbound_address: BTC_VAULT, memo: `=:e:${q.get('destination')}`, expected_amount_out: '29800000', expiry: w.clock + 600 }) });
  const r = makeRebalancer({ cfg: c2, rate: async () => MARKET, inventory: async () => ({ ethWei: ETH(1), sats }), fetchImpl, now: () => w.clock, vaultHistory: async () => 9,
    btcBuild: async () => { built++; return { txid: 'cd'.repeat(32), hex: '02aa', fee: 300 }; }, btcBroadcast: async () => {}, btcStatus: async () => ({ confirmations: 0 }),
    ethBalance: async () => ETH(0.1), ethNonce: async () => 1, ethReceipt: async () => null, sendEth: async () => { throw new Error('no'); }, address: ETH_DEST, btcDestination: BTC_DEST, gasReserveWei: ETH(0.02),
    load: async () => null, save: async () => {}, log: () => {}, alert: () => {} });
  assert.equal((await r.step()).did, 'confirming'); assert.equal(built, 0);
  w.clock += 1000; sats = 2.8e6;                                  // the next look reads the sides in band again
  assert.equal((await r.step()).did, 'in band');
  w.clock += 1000; sats = 4e7;
  assert.equal((await r.step()).did, 'confirming', 'the count starts again');
  w.clock += 1000;
  assert.equal((await r.step()).did, 'sent'); assert.equal(built, 1);
});
