// The pool maker (src/pool-maker.js): price, caps, quotes, and the carrier it would post for an exit-to-sats spend, on
// mainnet parameters with the real transaction code and stubs for the network, the pool replay and the proof check.
//   node --test tests/pool-maker.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as M from '../src/pool-maker.js';
import { loadTacitHeadless, setWalletKey, HttpError } from '../src/lib/headless-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.resolve(HERE, '../../dapp');

const loaded = await loadTacitHeadless('mainnet');
const { tacit: tacitMod, deps } = loaded;
const WALLET_KEY = '11'.repeat(32);
setWalletKey(loaded, WALLET_KEY);
const { makeBtcPoolZap } = await import(path.join(DAPP, 'btc-pool-zap.js'));
const zapReal = makeBtcPoolZap({ secp: deps.secp, sha256: deps.sha256, keccak256: deps.keccak_256 });
const { MAINNET_POOL_ASSETS } = await import(path.join(DAPP, 'sats/secret.js'));

// The app's own timers keep the process alive once the tests are done.
after(() => { setTimeout(() => process.exit(0), 100); });

const ENV = { MAKER_NETWORK: 'mainnet' };
const cfgWith = (extra = {}) => M.configFromEnv({ ...ENV, ...extra });
const hex = (b) => deps.bytesToHex(b);
const payeeHex = '0014' + 'ab'.repeat(20);          // a P2WPKH script: the recipient

// ── config ──
test('config: defaults, the TAC asset, and refusals', () => {
  const c = cfgWith();
  assert.equal(c.network, 'mainnet');
  assert.equal(c.assetId, M.TAC_MAINNET);
  assert.equal(M.TAC_MAINNET, MAINNET_POOL_ASSETS[0].id.replace(/^0x/, ''), 'the constant is the app\'s TAC id');
  assert.equal(c.spreadBps, 400); assert.equal(c.minSats, 20_000); assert.equal(c.maxSats, 100_000);
  assert.equal(c.dailySats, 500_000); assert.equal(c.dailyUnits, 500_000_000_000n); assert.equal(c.ipFills, 3);
  assert.equal(c.poolApi, 'https://tacit-btc-pool-mainnet.onrender.com');
  assert.equal(cfgWith({ MAKER_SPREAD_BPS: '0' }).spreadBps, 0, 'a zero spread is allowed');
  assert.equal(cfgWith({ MAKER_SPREAD_BPS: '99999' }).spreadBps, 5000, 'and the spread is capped');
  assert.throws(() => cfgWith({ MAKER_NETWORK: 'testnet' }), /mainnet or signet/);
  assert.throws(() => cfgWith({ MAKER_ASSET_ID: 'zz' }), /32-byte hex/);
  assert.throws(() => M.configFromEnv({ MAKER_NETWORK: 'signet' }), /32-byte hex/, 'no default asset off mainnet');
  assert.throws(() => cfgWith({ MAKER_MIN_SATS: '100' }), /at least 330/);
  assert.throws(() => cfgWith({ MAKER_MAX_SATS: '10000' }), /MAKER_MAX_SATS/);
  assert.throws(() => cfgWith({ MAKER_DAILY_SATS: '50000' }), /DAILY_SATS/);
});

// ── address ──
test('address: the BIP-173 vectors, and the status names the address the coin key pays to', async () => {
  const pub = deps.hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  assert.equal(M.p2wpkhAddressOf(deps, pub, 'mainnet'), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(M.p2wpkhAddressOf(deps, pub, 'signet'), 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  const { payoutScriptFor } = await import(path.join(DAPP, 'sats/secret.js'));
  const s = setup();
  const st = await s.maker.status();
  assert.match(st.float.address, /^bc1q[0-9a-z]{38}$/);
  assert.equal(hex(payoutScriptFor(st.float.address)), coinSpkHex, 'it decodes to the coin key\'s script');
});

// ── price ──
test('price: units round up, sats round down, and the maker never pays more than it takes', () => {
  const u = M.unitsForSats(50_000, 150, 400);
  assert.equal(u, BigInt(Math.ceil(50_000 * 1e8 / (150 * 0.96))), 'TAC for 50,000 sats at 150 less 4%');
  assert.ok(M.satsForUnits(u, 150, 400) >= 50_000, 'those units pay at least the sats asked');
  assert.ok(M.satsForUnits(u - 1n, 150, 400) < 50_000, 'and one unit fewer would not');
  assert.equal(M.satsForUnits(1_000_000_000n, 150, 0), 1500, '10 TAC at 150 with no spread');
  assert.equal(M.satsForUnits(1_000_000_000n, 150, 400), 1440, 'and 4% less with the spread');
  assert.ok(M.unitsForSats(50_000, 147.123, 400) > M.unitsForSats(50_000, 150, 400), 'a lower price takes more TAC');
  assert.equal(M.unitsForSats(1, 1e9, 0), 1n, 'tiny amounts still take a unit');
});

test('reference: a recent trade, lowered by a cheaper live ask; nothing without a recent trade', async () => {
  const cfg = cfgWith();
  const t = 2_000_000_000;
  const sale = (tac, sats, extra = {}) => ({ asset_opening: { amount: String(Math.round(tac * 1e8)) }, min_price_sats: sats, expiry: t + 3600, expired: false, ...extra });
  const serve = (mark, ts, sales) => async (u) => (String(u).includes('/preauth-sales') ? { sales } : { mark_price: { unit: mark, ts } });
  const ref = (fetchJson) => M.readReference({ cfg, now: () => t, fetchJson });
  let r = await ref(serve(150, t - 3600, [sale(100, 16_800)]));
  assert.deepEqual([r.unit, r.basis], [150, 'trade'], 'asks above the trade do not raise the price');
  r = await ref(serve(150, t - 3600, [sale(100, 14_000), sale(10, 1000, { expired: true }), sale(10, 900, { expiry: t - 1 })]));
  assert.deepEqual([r.unit, r.basis], [140, 'ask'], 'a cheaper live ask lowers it; expired ones are left out');
  r = await ref(serve(150, t - 3600, []));
  assert.equal(r.unit, 150, 'an empty book prices off the trade');
  assert.equal(await ref(serve(150, t - 8 * 86400, [sale(100, 14_000)])), null, 'a trade older than a week is not a price');
  assert.equal(await ref(serve(150, undefined, [])), null, 'and one with no time is not either');
  assert.equal(await ref(serve(null, null, [sale(100, 14_000)])), null, 'an ask alone is not a price');
  assert.equal(await ref(async () => null), null, 'no answer, no price');
});

// ── the maker, with stubs ──
const coinKey = M.coinKeyFor(loaded, WALLET_KEY);
const coinSpkHex = hex(tacitMod.p2wpkhScript(coinKey.pub));
const mainSpkHex = hex(tacitMod.p2wpkhScript(tacitMod.wallet.pub));
const txidOf = (n) => n.toString(16).padStart(64, '0');

function setup({ cfg = cfgWith({ MAKER_FEE_RATE: '1.5' }), coins = null, ref = { unit: 150, basis: 'trade', mark: 150, ask: null }, verify = async () => true, nullifierSpent = false, failBroadcast = null } = {}) {
  let t = 1_800_000_000;
  const state = {};
  const store = { load: () => state, save: () => {} };
  const utxos = coins || [1, 2, 3, 4].map((n) => ({ txid: txidOf(n), vout: 0, value: 150_000, status: { confirmed: true } }));
  const txs = [], sent = [];
  const tacit = {
    ...tacitMod,
    serializeTx: (tx) => { txs.push(tx); return tacitMod.serializeTx(tx); },
    broadcast: async (h) => { if (failBroadcast === 'commit') throw new Error('no route'); sent.push(['commit', h]); return 'ok'; },
    broadcastWithRetry: async (h) => { if (failBroadcast === 'reveal') throw new Error('rejected'); sent.push(['reveal', h]); return 'ok'; },
  };
  const calls = { validate: [] };
  const mk = {
    key: coinKey,
    pool: { parseSpend: () => ({ hAnchor: 1000, nullifiers: ['0x' + '01'.repeat(32)] }) },
    zap: {
      validateExitToSats: async (a) => { calls.validate.push(a); if (a.verify) await a.verify(); return { exitVout: a.maker.exitVout, wantVout: a.maker.vout, wantValue: a.maker.sats, payoutScriptPubKey: '0x' + payeeHex }; },
      makerCarrierOutputs: zapReal.makerCarrierOutputs,
    },
    verifier: { verify: async (...a) => { if (verify === false) throw new Error('btc-pool-zap: proof does not verify'); return verify(...a); }, system: { id: 'halo2-test', vkHash: '0xabc' } },
    poolGet: async (p) => {
      if (p === '/btc-pool/status') return { height: 1010, halted: false, proofSystem: 'halo2-test', vkHash: '0xabc' };
      if (p.startsWith('/btc-pool/root/')) return { retained: true, root: '0x' + '22'.repeat(32) };
      if (p.startsWith('/btc-pool/nullifier/')) return { spent: nullifierSpent };
      throw new Error('unexpected pool read ' + p);
    },
    utxos: async (spkHex) => (spkHex === coinSpkHex ? utxos : []),
  };
  const maker = M.makePoolMaker({ tacit, deps, cfg, store, mk, logger: () => {}, now: () => t, reference: async () => ref });
  return { maker, state, txs, sent, calls, cfg, setNow: (x) => { t = x; }, advance: (s) => { t += s; }, utxos };
}
const offerFor = (units) => ({ exitOpening: { value: String(units), blinding: '0x' + '07'.repeat(32) }, payoutScriptPubKey: '0x' + payeeHex });
const payloadHex = () => 'cd'.repeat(3000);
const reject = async (p, status, re) => assert.rejects(p, (e) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)), `expected ${status} ${re || ''}`);

test('quote: by sats, with the terms the client builds its spend from', async () => {
  const { maker, cfg } = setup();
  const q = await maker.quote({ sats: '50000', ip: '1.1.1.1' });
  assert.equal(q.sats, 50_000);
  assert.equal(q.units, M.unitsForSats(50_000, 150, cfg.spreadBps).toString());
  assert.equal(q.asset, M.TAC_MAINNET);
  assert.equal(q.makerSpk, mainSpkHex, 'the exit pays the wallet key, not the coin key');
  assert.notEqual(q.makerSpk, coinSpkHex);
  assert.deepEqual([q.exitVout, q.wantVout], [0, 1]);
  assert.match(q.quoteId, /^[0-9a-f]{32}$/);
  assert.ok(q.bind.txid && Number.isInteger(q.bind.vout), 'a bind coin is named');
  assert.deepEqual(q.price, { unit: 150, basis: 'trade', spread_bps: 400 });
  assert.equal(q.expiry, 1_800_000_000 + 1200);
});

test('quote: by units pays the sats those units fetch', async () => {
  const { maker } = setup();
  const q = await maker.quote({ units: '35000000000', ip: 'x' });   // 350 TAC
  assert.equal(q.sats, M.satsForUnits(35_000_000_000n, 150, 400));
  assert.equal(q.units, '35000000000');
});

test('quote: refusals', async () => {
  const s = setup();
  await reject(s.maker.quote({ ip: 'x' }), 400, /sats or units/);
  await reject(s.maker.quote({ sats: '50000', units: '1', ip: 'x' }), 400, /not both/);
  await reject(s.maker.quote({ sats: 'abc', ip: 'x' }), 400, /positive integer/);
  await reject(s.maker.quote({ sats: '-5', ip: 'x' }), 400, /positive integer/);
  await reject(s.maker.quote({ sats: '19999', ip: 'x' }), 400, /at least 20000/);
  await reject(s.maker.quote({ sats: '100001', ip: 'x' }), 400, /at most 100000/);
  const none = setup({ ref: null });
  await reject(none.maker.quote({ sats: '50000', ip: 'x' }), 503, /no recent trade/);
  const poor = setup({ coins: [{ txid: txidOf(1), vout: 0, value: 25_000, status: { confirmed: true } }, { txid: txidOf(2), vout: 0, value: 25_000, status: { confirmed: true } }] });
  await reject(poor.maker.quote({ sats: '50000', ip: 'x' }), 503, /no sats free/);
});

test('quote: every open quote holds its own bind coin, and a client holds at most two', async () => {
  const s = setup();
  const a = await s.maker.quote({ sats: '30000', ip: 'A' });
  const b = await s.maker.quote({ sats: '30000', ip: 'A' });
  assert.notDeepEqual(a.bind, b.bind, 'a second quote takes another coin');
  await reject(s.maker.quote({ sats: '30000', ip: 'A' }), 429, /open quotes/);
  const c = await s.maker.quote({ sats: '30000', ip: 'B' });
  assert.ok(![a.bind, b.bind].some((x) => x.txid === c.bind.txid), 'and another client gets neither');
  s.advance(1300);
  const d = await s.maker.quote({ sats: '30000', ip: 'A' });
  assert.ok(d.quoteId, 'quotes lapse and free their coins');
});

test('quote: the daily budgets count open quotes and fills', async () => {
  const s = setup({ cfg: cfgWith({ MAKER_DAILY_SATS: '100000', MAKER_MAX_SATS: '100000', MAKER_FEE_RATE: '1.5' }) });
  await s.maker.quote({ sats: '60000', ip: 'A' });
  await reject(s.maker.quote({ sats: '60000', ip: 'B' }), 429, /daily budget/);
  const u = setup({ cfg: cfgWith({ MAKER_DAILY_UNITS: '20000000000', MAKER_FEE_RATE: '1.5' }) });   // 200 TAC a day
  await reject(u.maker.quote({ sats: '50000', ip: 'A' }), 429, /daily amount of TAC/);
});

test('fill: posts one commit and one reveal; the payee is paid exactly the sats, in the same transaction as the exit', async () => {
  const s = setup();
  const q = await s.maker.quote({ sats: '50000', ip: 'A' });
  const r = await s.maker.fill({ quoteId: q.quoteId, payload: payloadHex(), offer: offerFor(q.units), ip: 'A' });
  assert.equal(r.sats, 50_000); assert.equal(r.units, q.units);
  assert.deepEqual(s.sent.map((x) => x[0]), ['commit', 'reveal'], 'the commit goes first');
  const [commit, reveal] = s.txs;
  assert.equal(r.commitTxid, tacitMod.txid(commit)); assert.equal(r.txid, tacitMod.txid(reveal));
  // the reveal spends the commit and the quoted bind coin
  assert.deepEqual([reveal.inputs[0].txid, reveal.inputs[0].vout], [tacitMod.txid(commit), 0]);
  assert.deepEqual([reveal.inputs[1].txid, reveal.inputs[1].vout], [q.bind.txid, q.bind.vout]);
  // output 0 pays the maker's wallet key (the exit), output 1 pays the payee exactly the sats
  assert.equal(hex(reveal.outputs[0].script), mainSpkHex);
  assert.equal(reveal.outputs[0].value, tacitMod.DUST);
  assert.equal(hex(reveal.outputs[1].script), payeeHex);
  assert.equal(reveal.outputs[1].value, 50_000);
  assert.ok(reveal.outputs.slice(2).every((o) => hex(o.script) === coinSpkHex), 'anything else is change to the coin key');
  // every amount is whole sats, and the fees add up
  for (const tx of [commit, reveal]) for (const o of tx.outputs) assert.ok(Number.isInteger(o.value) && o.value > 0, `whole sats: ${o.value}`);
  const coinValue = (i) => s.utxos.find((u) => u.txid === i.txid && u.vout === i.vout).value;
  const commitIn = commit.inputs.reduce((a, i) => a + coinValue(i), 0), commitOut = commit.outputs.reduce((a, o) => a + o.value, 0);
  assert.ok(commitIn - commitOut > 0 && commitIn - commitOut < 1500, `commit fee ${commitIn - commitOut}`);
  const revealIn = commit.outputs[0].value + coinValue(reveal.inputs[1]), revealOut = reveal.outputs.reduce((a, o) => a + o.value, 0);
  assert.ok(revealIn - revealOut > 0 && revealIn - revealOut < 3500, `reveal fee ${revealIn - revealOut}`);
  assert.ok(reveal.inputs.every((i) => i.witness.length > 0), 'inputs are signed');
  // recorded: the quote is gone, the fill counted, the exit note kept for the operator
  assert.equal(Object.keys(s.state.makerQuotes).length, 0);
  assert.equal(s.state.makerFillTotal, 1);
  assert.deepEqual([s.state.makerNotes[0].txid, s.state.makerNotes[0].vout, s.state.makerNotes[0].units], [r.txid, 0, q.units]);
  assert.equal(s.state.makerNotes[0].blinding, '07'.repeat(32));
  const st = await s.maker.status();
  assert.equal(st.fills_total, 1); assert.equal(st.inventory_units, q.units);
  assert.equal(st.sats_left_today, 500_000 - 50_000);
  assert.equal(st.recent_fills[0].txid, r.txid);
  assert.ok(!('ip' in st.recent_fills[0]), 'status shows no client tags');
  // the spend was checked against the quote's terms
  assert.equal(s.calls.validate.length, 1);
  assert.equal(s.calls.validate[0].amount, BigInt(q.units));
  assert.equal(s.calls.validate[0].asset, '0x' + M.TAC_MAINNET);
  assert.equal(s.calls.validate[0].maker.sats, 50_000n);
});

test('fill: refusals leave the quote open and spend nothing', async () => {
  const s = setup();
  const q = await s.maker.quote({ sats: '50000', ip: 'A' });
  const go = (over = {}) => s.maker.fill({ quoteId: q.quoteId, payload: payloadHex(), offer: offerFor(q.units), ip: 'A', ...over });
  await reject(go({ quoteId: 'nope' }), 400, /quoteId/);
  await reject(go({ quoteId: '0'.repeat(32) }), 404, /no such quote/);
  await reject(go({ payload: 'xyz' }), 400, /payload must be hex/);
  await reject(go({ payload: '' }), 400, /payload must be hex/);
  await reject(go({ offer: null }), 400, /offer required/);
  await reject(go({ offer: { exitOpening: { value: 'x', blinding: '1' }, payoutScriptPubKey: '0x00' } }), 400, /exitOpening.value/);
  await reject(go({ offer: { exitOpening: { value: '5', blinding: 'zz' }, payoutScriptPubKey: '0x00' } }), 400, /blinding/);
  assert.equal(s.sent.length, 0);
  assert.equal(s.state.makerQuotes[q.quoteId].state, 'open');
  const bad = setup({ verify: false });
  const bq = await bad.maker.quote({ sats: '50000', ip: 'A' });
  await reject(bad.maker.fill({ quoteId: bq.quoteId, payload: payloadHex(), offer: offerFor(bq.units), ip: 'A' }), 400, /proof does not verify/);
  assert.equal(bad.sent.length, 0); assert.equal(bad.state.makerQuotes[bq.quoteId].state, 'open');
  const spent = setup({ nullifierSpent: true });
  const sq = await spent.maker.quote({ sats: '50000', ip: 'A' });
  await reject(spent.maker.fill({ quoteId: sq.quoteId, payload: payloadHex(), offer: offerFor(sq.units), ip: 'A' }), 409, /already spent/);
  assert.equal(spent.sent.length, 0);
  s.advance(1300);
  await reject(go(), 410, /expired/);
});

test('fill: a quote fills once, and a client fills at most its share a day', async () => {
  const s = setup({ cfg: cfgWith({ MAKER_IP_FILLS: '1', MAKER_FEE_RATE: '1.5' }) });
  const q = await s.maker.quote({ sats: '30000', ip: 'A' });
  await s.maker.fill({ quoteId: q.quoteId, payload: payloadHex(), offer: offerFor(q.units), ip: 'A' });
  await reject(s.maker.fill({ quoteId: q.quoteId, payload: payloadHex(), offer: offerFor(q.units), ip: 'A' }), 404, /no such quote/);
  await reject(s.maker.quote({ sats: '30000', ip: 'A' }), 429, /at most 1 swaps/);
  const other = await s.maker.quote({ sats: '30000', ip: 'B' });
  assert.ok(other.quoteId, 'another client is not held back');
});

test('fill: a carrier that never went out frees the quote; one whose commit went out is recorded and not retried', async () => {
  const early = setup({ failBroadcast: 'commit' });
  const q1 = await early.maker.quote({ sats: '50000', ip: 'A' });
  await assert.rejects(early.maker.fill({ quoteId: q1.quoteId, payload: payloadHex(), offer: offerFor(q1.units), ip: 'A' }), /no route/);
  assert.equal(early.state.makerQuotes[q1.quoteId].state, 'open', 'nothing went out, so it can be tried again');
  const late = setup({ failBroadcast: 'reveal' });
  const q2 = await late.maker.quote({ sats: '50000', ip: 'A' });
  await assert.rejects(late.maker.fill({ quoteId: q2.quoteId, payload: payloadHex(), offer: offerFor(q2.units), ip: 'A' }), /rejected/);
  assert.equal(late.state.makerQuotes[q2.quoteId].state, 'failed');
  assert.equal(late.state.makerStranded.length, 1);
  assert.equal(late.state.makerStranded[0].quoteId, q2.quoteId);
  assert.match(late.state.makerStranded[0].revealHex, /^[0-9a-f]+$/);
  await reject(late.maker.fill({ quoteId: q2.quoteId, payload: payloadHex(), offer: offerFor(q2.units), ip: 'A' }), 409, /already being filled/);
  const st = await late.maker.status();
  assert.equal(st.stranded, 1);
});

test('restart: a fill cut off mid-way is not retried', () => {
  const state = { makerQuotes: { a: { id: 'a', state: 'filling', expiry: 9e9, bind: { txid: txidOf(1), vout: 0 }, sats: 1, units: '1' } } };
  const s = setup();
  M.makePoolMaker({ tacit: tacitMod, deps, cfg: s.cfg, store: { load: () => state, save: () => {} }, mk: { key: coinKey }, logger: () => {}, reference: async () => null });
  assert.equal(state.makerQuotes.a.state, 'failed');
});

test('status: says whether it is quoting, and where the float goes', async () => {
  const s = setup();
  let st = await s.maker.status();
  assert.equal(st.quoting, true);
  assert.equal(st.float.coins, 4); assert.equal(st.float.sats, 600_000);
  assert.equal(st.reference.unit, 150);
  assert.equal(st.main_key, hex(tacitMod.wallet.pub));
  const dry = setup({ coins: [] });
  assert.equal((await dry.maker.status()).quoting, false, 'no coins, no quoting');
  const mute = setup({ ref: null });
  assert.equal((await mute.maker.status()).quoting, false, 'no price, no quoting');
});

// ── HTTP ──
test('http: routes, methods, and the origin list', async () => {
  const s = setup();
  const server = createServer(M.makeHandler(s.maker, { corsOrigins: ['https://tacit.finance'], logger: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, o = {}) => fetch(base + p, o).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
  try {
    assert.equal((await call('/health')).status, 200);
    assert.equal((await call('/nope')).status, 404);
    const st = await call('/maker/status');
    assert.equal(st.status, 200); assert.equal(st.body.asset_id, M.TAC_MAINNET);
    let r = await call('/maker/quote?sats=50000', { headers: { origin: 'https://tacit.finance' } });
    assert.equal(r.status, 200); assert.equal(r.body.sats, 50_000);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    r = await call('/maker/quote?sats=50000', { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    r = await call('/maker/quote?sats=5', { headers: { origin: 'https://tacit.finance' } });
    assert.equal(r.status, 400); assert.match(r.body.error, /at least/);
    r = await call('/maker/quote', { method: 'POST' });
    assert.equal(r.status, 405);
    r = await call('/maker/fill', { method: 'POST', body: 'not json', headers: { origin: 'https://tacit.finance' } });
    assert.equal(r.status, 400); assert.match(r.body.error, /JSON/);
    r = await call('/maker/fill', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    r = await call('/maker/fill', { method: 'OPTIONS', headers: { origin: 'https://tacit.finance' } });
    assert.equal(r.status, 204);
    // a full round trip over HTTP
    const q = (await call('/maker/quote?sats=40000', { headers: { origin: 'https://tacit.finance' } })).body;
    r = await call('/maker/fill', { method: 'POST', headers: { origin: 'https://tacit.finance', 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId, payload: payloadHex(), offer: offerFor(q.units) }) });
    assert.equal(r.status, 200); assert.equal(r.body.sats, 40_000);
  } finally { server.close(); }
});
