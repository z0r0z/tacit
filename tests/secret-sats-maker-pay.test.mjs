// payThroughMaker (dapp/sats/secret.js): a payment to a bitcoin address from shielded TAC. It quotes by the sats the
// recipient is to get, builds a spend that exits the TAC to the maker and wants those sats paid to the RECIPIENT's
// script (not a fresh key of the payer's), and posts it with request shapes the maker's validator
// (btc-pool-zap.js validateExitToSats) accepts. The pool replay and the maker are mocked; proofs use a stand-in system.
//   node tests/secret-sats-maker-pay.test.mjs

import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';
import { secp, sha256, keccak_256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { makeBtcPoolZap } from '../dapp/btc-pool-zap.js';
import { publicSignals } from '../dapp/btc-pool-zk.js';
import * as W from '../worker/src/btc-shielded-pool.js';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const MAKER = 'https://maker.test';
const POOL = 'https://pool.test';
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
const RECIPIENT = Uint8Array.from([0x00, 0x14, ...Array(20).fill(0xab)]);
const BIND = { txid: 'b1'.repeat(32), vout: 2 };
const seen = { quote: null, fill: null, validated: null, statusReads: 0 };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
let mode = 'ok';

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url), 'http://localhost/');
  const p = u.pathname;
  if (u.origin === MAKER) {
    if (p === '/maker/quote') {
      seen.quote = u.searchParams.get('sats');
      if (mode === 'budget') return json({ error: 'the maker has bought its daily budget; try again later' }, 429);
      const sats = mode === 'terms' ? 999 : Number(seen.quote);
      return json({ quoteId: 'q'.repeat(32), asset: ASSET, units: '10000', sats, makerSpk: MAKER_SPK, exitVout: 0, wantVout: 1, bind: BIND, expiry: 2e9, price: { unit: 150, basis: 'trade', spread_bps: 400 } });
    }
    if (p === '/maker/fill') {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      seen.fill = body;
      seen.validated = await zap.validateExitToSats({
        pool: bp, payload: hexToBytes(strip(body.payload)), offer: body.offer,
        maker: { spk: '0x' + MAKER_SPK, sats: BigInt(seen.quote), vout: 1, exitVout: 0, bind: BIND },
        amount: 10_000n, asset: '0x' + ASSET, root: ROOT, verify: async () => true,
      });
      if (mode === 'lost') throw new TypeError('network down');
      return json({ txid: 'e'.repeat(64), commitTxid: 'd'.repeat(64), sats: Number(seen.validated.wantValue), units: '10000', exitVout: 0, wantVout: 1 });
    }
    if (p === '/maker/status') { seen.statusReads++; return json({ recent_fills: [{ quoteId: 'q'.repeat(32), txid: 'f'.repeat(64), sats: Number(seen.quote), units: '10000' }] }); }
  }
  if (u.origin === POOL) {
    if (p === '/btc-pool/status') return json({ height: 1006, halted: null });
    if (p === '/btc-pool/notes') {
      const from = Number(u.searchParams.get('from'));
      const rows = from === 0 ? [{ leafIndex: 0, txid: 'a0'.repeat(32), height: 1000, leaf: note.leaf, asset: note.asset, pk_eph: note.pkEph, ct_note: note.ctNote }] : [];
      return json({ height: 1006, from, notes: rows, next: rows.length ? 1 : from });
    }
    if (p.startsWith('/btc-pool/nullifier/')) return json({ spent: false });
    // a wallet's spent flags come from the replay's whole list of nullifiers (none spent), and the paths it works out from the feed are checked against the replay's own root
    if (p === '/btc-pool/nullifiers') return json({ nullifiers: [], next: null });
    let m;
    if ((m = p.match(/^\/btc-pool\/root\/(\d+)$/))) return json({ height: Number(m[1]), root: '0x' + bytesToHex(st.tree.rootAndPathAt(0, 1).root), retained: true });
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
  try { await fn(); passed++; console.log(`ok   ${name}`); localStorage.removeItem('tacit-pool-pending-v1'); }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}
const args = (over = {}) => ({ poolWallet: pw, sats: 950, payoutScript: RECIPIENT, asset: ASSET, anchor: 1006, makerUrl: MAKER, prove: (b) => bp.prove(b, standIn), ...over });

await test('quotes by the recipient\'s sats; the spend wants exactly those sats paid to the recipient\'s script; no fresh key is used up', async () => {
  mode = 'ok';
  const used = new Set(), says = [];
  const r = await secret.payThroughMaker({}, args({ usedScripts: used, say: (m) => says.push(m) }));
  assert.equal(seen.quote, '950');
  assert.equal(r.revealTxid, 'e'.repeat(64));
  assert.equal(r.sats, 950); assert.equal(r.units, 10_000n);
  assert.equal(seen.validated.wantValue, 950n);
  assert.deepEqual([seen.validated.exitVout, seen.validated.wantVout], [0, 1]);
  assert.equal(seen.validated.payoutScriptPubKey, '0x' + bytesToHex(RECIPIENT), 'the want pays the recipient');
  assert.equal(seen.fill.offer.payoutScriptPubKey, '0x' + bytesToHex(RECIPIENT));
  assert.equal(used.size, 0);
  assert.equal(strip(seen.validated.spend.bind.txid), BIND.txid);
  const mine = bp.scan(pw, seen.validated.spend.outputs);
  assert.equal(mine.reduce((t, x) => t + x.value, 0n), 20_000n, 'the change stays in the pool');
  assert.ok(says.some((m) => /maker/.test(m)));
  assert.deepEqual(r.price, { unit: 150, basis: 'trade', spread_bps: 400 });
});

await test('a quote for other terms than asked is refused before anything is proved', async () => {
  mode = 'terms';
  let proved = 0;
  await assert.rejects(secret.payThroughMaker({}, args({ prove: async (b) => { proved++; return bp.prove(b, standIn); } })), /quoted other terms/);
  assert.equal(proved, 0);
});

await test('the maker\'s refusals surface as one line naming the maker', async () => {
  mode = 'budget';
  await assert.rejects(secret.payThroughMaker({}, args()), /The maker: the maker has bought its daily budget/);
});

await test('a fill whose answer is lost is found in the maker\'s recent fills', async () => {
  mode = 'lost'; seen.statusReads = 0;
  const realSetTimeout = globalThis.setTimeout;
  const r = await secret.payThroughMaker({}, args());
  assert.equal(r.revealTxid, 'f'.repeat(64));
  assert.ok(seen.statusReads >= 1);
  void realSetTimeout;
});

console.log(`${passed} passed`);
