// /sats step 6 "Back to sats" (dapp/sats/secret.js): the step renders from the faucet's maker terms once the
// wallet holds a pool note, and sellForSats runs quote → exitToSats → prove → fill with request shapes the
// maker's validator (btc-pool-zap.js validateExitToSats) accepts. The pool replay and the faucet are mocked;
// proofs use a stand-in system.
//   node tests/secret-sats-sell.test.mjs

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { secp, sha256, keccak_256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { makeBtcPoolZap } from '../dapp/btc-pool-zap.js';
import { publicSignals } from '../dapp/btc-pool-zk.js';
import * as W from '../worker/src/btc-shielded-pool.js';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const FAUCET = 'https://faucet.test';
const POOL = 'https://pool.test';
globalThis.__SATS_FAUCET_URL__ = FAUCET;
globalThis.__TACIT_BTC_POOL_API__ = POOL;

const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
const zap = makeBtcPoolZap({ secp, sha256, keccak256: keccak_256 });
const standIn = { prove: async (input) => ({ wire: new Uint8Array(256), publicSignals: publicSignals(input) }) };
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const ASSET = 'ab'.repeat(32);
const PRIV = new Uint8Array(32).fill(5);
const PUB = secp.getPublicKey(PRIV, true);

const secret = await import('../dapp/sats/secret.js');
const pw = secret.poolWalletFor(PRIV, 'signet');

// One 30,000-unit note of the wallet at height 1000; the replay tip is 1006.
const note = bp.createNote(pw.addressString, '0x' + ASSET, 30_000n);
const st = new W.BtcPoolState();
st.beginBlock(1000); st.tree.append(hexToBytes(strip(note.leaf))); st.leafHeights.push(1000); st.endBlock();
for (let h = 1001; h <= 1006; h++) { st.beginBlock(h); st.endBlock(); }
const ROOT = '0x' + bytesToHex(st.roots.get(1006));

const MAKER_SPK = '0014' + '77'.repeat(20);
const BIND = { txid: 'b1'.repeat(32), vout: 2 };
const STATUS = {
  network: 'signet', asset_id: ASSET, ticker: 'cBTC', decimals: 8, lot: '10000', price_sats: 1000, open_sales: [],
  maker: { enabled: true, spread_bps: 500, sats_per_lot: 950, min_units: '3474', max_units: '50000', sats_left_today: 50000 },
};
const seen = { quote: null, fill: null, validated: null };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url), 'http://localhost/');
  const p = u.pathname;
  if (u.origin === FAUCET) {
    if (p === '/faucet/status') return json(STATUS);
    if (p === '/faucet/maker/quote') {
      seen.quote = u.searchParams.get('units');
      return json({ quoteId: 'q'.repeat(32), asset: ASSET, units: seen.quote, sats: 950, makerSpk: MAKER_SPK, exitVout: 0, wantVout: 1, bind: BIND, expiry: 2e9 });
    }
    if (p === '/faucet/maker/fill') {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      seen.fill = body;
      // The maker's own validator over the posted payload and offer.
      seen.validated = await zap.validateExitToSats({
        pool: bp, payload: hexToBytes(strip(body.payload)), offer: body.offer,
        maker: { spk: '0x' + MAKER_SPK, sats: 950n, vout: 1, exitVout: 0, bind: BIND },
        amount: BigInt(seen.quote), asset: '0x' + ASSET, root: ROOT, verify: async () => true,
      });
      return json({ txid: 'e'.repeat(64), commitTxid: 'd'.repeat(64), sats: Number(seen.validated.wantValue), units: seen.quote, exitVout: 0, wantVout: 1 });
    }
  }
  if (u.origin === POOL) {
    if (p === '/btc-pool/status') return json({ height: 1006, halted: null });
    if (p === '/btc-pool/notes') {
      const from = Number(u.searchParams.get('from'));
      const rows = from === 0 ? [{ leafIndex: 0, txid: 'a0'.repeat(32), height: 1000, leaf: note.leaf, asset: note.asset, pk_eph: note.pkEph, ct_note: note.ctNote }] : [];
      return json({ height: 1006, from, notes: rows, next: rows.length ? 1 : from });
    }
    if (p.startsWith('/btc-pool/nullifier/')) return json({ spent: false });
    let m;
    if ((m = p.match(/^\/btc-pool\/path\/(\d+)$/))) {
      const at = Number(u.searchParams.get('at'));
      const { root, path } = st.tree.rootAndPathAt(Number(m[1]), 1);
      return json({ leafIndex: 0, leaf: note.leaf, height: 1006, hAnchor: at, root: '0x' + bytesToHex(root), path: path.map((x) => '0x' + bytesToHex(x)) });
    }
  }
  return json({ error: `unmocked ${url}` }, 404);
};

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}
const tick = () => new Promise((r) => setTimeout(r, 20));

await test('step 6 is a live pool step: locked without a pool note, active with one, with the faucet\'s terms and an amount field', async () => {
  const tacit = { NET: { name: 'signet', explorer: 'https://mempool.space/signet' }, DUST: 546, wallet: { priv: PRIV, pub: PUB } };
  const pubHex = bytesToHex(PUB);
  let notify = null;
  const root = document.getElementById('root');
  const view = secret.mount(root, { tacit, wallet: tacit.wallet, network: 'signet', onWallet: (fn) => { notify = fn; } });
  const sell = () => root.querySelector('li[data-step="sell"]');
  assert.equal(sell().querySelector('.step-title').textContent, 'Back to sats');
  assert.equal(root.querySelectorAll('li.step').length, 6);
  assert.ok(!/is-soon/.test(sell().className), 'no longer marked soon');
  notify({ connected: true, unlocked: true, pubHex, sats: 50_000 });
  await tick();
  assert.match(sell().className, /is-locked/, 'locked before the wallet holds a pool note');

  localStorage.setItem(`tacit-sats-demo-v2:signet:${pubHex}`, JSON.stringify({ poolNote: { value: '30000' }, shield: { revealTxid: 'a0'.repeat(32) } }));
  notify({ connected: true, unlocked: true, pubHex: pubHex, sats: 50_000 });
  // A different pubHex reloads state; nudge by reconnecting with the same key after clearing.
  notify({ connected: false, unlocked: false, pubHex: null, sats: null });
  notify({ connected: true, unlocked: true, pubHex, sats: 50_000 });
  for (let i = 0; i < 100 && !/Private balance/.test(sell().textContent); i++) { await tick(); view.render(); }
  assert.match(sell().className, /is-active/);
  const input = sell().querySelector('#pool-sell-amt');
  assert.ok(input, 'amount field');
  const btn = [...sell().querySelectorAll('button')].find((b) => b.textContent === 'Swap for sats');
  assert.ok(btn && !btn.disabled, 'swap button');
  assert.match(sell().textContent, /950 signet sats per 0\.0001/);
  assert.match(sell().textContent, /Private balance: 0\.0003 cBTC/);
  input.value = '0.0001';
  input.dispatchEvent(new dom.window.Event('input'));
  assert.match(sell().textContent, /≈ 950 signet sats/);
  view.stop();
});

await test('sellForSats: quote for the amount, a spend the maker validates, want to a fresh exit key, change kept private', async () => {
  const used = new Set();
  const says = [];
  const r = await secret.sellForSats({}, {
    poolWallet: pw, amount: 10_000n, asset: ASSET, anchor: 1006, usedScripts: used, faucetUrl: FAUCET,
    say: (m) => says.push(m), prove: (built) => bp.prove(built, standIn),
  });
  assert.equal(seen.quote, '10000');
  assert.equal(r.revealTxid, 'e'.repeat(64));
  assert.equal(r.sats, 950);
  assert.equal(seen.fill.quoteId, 'q'.repeat(32));
  assert.equal(typeof seen.fill.offer.exitOpening.value, 'string');
  assert.equal(seen.validated.wantValue, 950n);
  assert.deepEqual([seen.validated.exitVout, seen.validated.wantVout], [0, 1]);
  const key = bp.deriveExitKey(pw, 0);
  assert.equal(r.payout.scriptPubKey, key.scriptPubKey, 'the first fresh exit key');
  assert.equal(seen.validated.payoutScriptPubKey, key.scriptPubKey);
  assert.ok(used.has(key.destSpkHash), 'the key is marked used');
  const sp = seen.validated.spend;
  assert.equal(strip(sp.bind.txid), BIND.txid);
  const mine = bp.scan(pw, sp.outputs);
  assert.equal(mine.reduce((t, x) => t + x.value, 0n), 20_000n, 'the change stays in the pool');
  assert.ok(mine.every((x) => x.internal));
  assert.ok(says.some((m) => /faucet/.test(m)));
  // A second sale takes the next key.
  const r2 = await secret.sellForSats({}, { poolWallet: pw, amount: 4_000n, asset: ASSET, anchor: 1006, usedScripts: used, faucetUrl: FAUCET, prove: (built) => bp.prove(built, standIn) });
  assert.equal(r2.payout.counter, 1);
});

await test('sellForSats: faucet errors surface as one line', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes('/faucet/maker/quote') ? json({ error: 'the faucet has bought back its daily budget; try again later' }, 429) : saved(url, init));
  try {
    await assert.rejects(secret.sellForSats({}, { poolWallet: pw, amount: 10_000n, asset: ASSET, anchor: 1006, faucetUrl: FAUCET, prove: (b) => bp.prove(b, standIn) }), /Faucet: the faucet has bought back its daily budget/);
  } finally { globalThis.fetch = saved; }
});

await test('sellForSats: a fill whose answer is lost is found in the faucet\'s recent fills', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/faucet/maker/fill')) throw new TypeError('network error');
    if (u.endsWith('/faucet/status')) return json({ ...STATUS, maker: { ...STATUS.maker, recent_fills: [{ quoteId: 'q'.repeat(32), txid: 'f'.repeat(64), units: '10000', sats: 950 }] } });
    return saved(url, init);
  };
  try {
    const r = await secret.sellForSats({}, { poolWallet: pw, amount: 10_000n, asset: ASSET, anchor: 1006, faucetUrl: FAUCET, prove: (b) => bp.prove(b, standIn) });
    assert.equal(r.revealTxid, 'f'.repeat(64));
    assert.equal(r.sats, 950);
  } finally { globalThis.fetch = saved; }
});

console.log(`\n${passed} passed`);
process.exit(process.exitCode || 0);
