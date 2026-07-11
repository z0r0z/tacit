// Regression coverage for getUtxos's >500-UTXO fallback (dapp/tacit.js).
//
// Esplora hard-caps `/address/:addr/utxo` at 500 unspent outputs and rejects
// over-the-cap requests with `400 Too many unspent transaction outputs
// (>500). Contact support to raise limits.` Wallets with accumulated dust /
// change / fragmented asset UTXOs trip this and lose visibility into their
// own holdings (including freshly-minted assets) until the count drops.
//
// The fix in getUtxos catches that specific 400 and reconstructs the unspent
// set from paginated `/address/:addr/txs/{chain,mempool}` history, applying
// `received \ spent` over outputs paying the address. This test pins the
// behaviour so the fallback can't silently regress:
//
//   - Esplora 400 with the >500 message routes to the fallback.
//   - Other 400s (malformed address, etc.) propagate to the caller.
//   - The fallback paginates `/txs/chain` correctly via last_seen_txid and
//     terminates on a short page.
//   - Mempool txs are folded into the unspent set with status.confirmed=false.
//   - Outputs paying other addresses are ignored (no false positives).
//   - Inputs spending earlier outputs paying us mark them as spent
//     (no zombie UTXOs).
//   - Coinbase vins (no prevout) don't blow up the spent-set tally.
//   - Mempool fetch failure is non-fatal; chain-only result still returns.
//
// Run: `node getutxos-fallback.test.mjs`

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const { getUtxos } = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

function testAddr(n) {
  return `bc1q${String(n).padStart(2, '0')}abcdefghijklmnopqrstuvwxyz012345`;
}
const OTHER = 'bc1qotherotherotherotherotherotherotherxy';

function txid(n) {
  // 64-hex deterministic txids. Distinct values per `n` so set keys collide
  // only when intended.
  const s = n.toString(16).padStart(8, '0');
  return (s + s + s + s + s + s + s + s).slice(0, 64);
}

function chainTx({ id, vouts = [], vins = [], height = 800000 }) {
  return {
    txid: id,
    vin: vins,
    vout: vouts,
    status: { confirmed: true, block_height: height, block_hash: 'h', block_time: 1700000000 },
  };
}
function mempoolTx({ id, vouts = [], vins = [] }) {
  return {
    txid: id,
    vin: vins,
    vout: vouts,
    status: { confirmed: false },
  };
}
function payTo(addr, value) { return { scriptpubkey_address: addr, value }; }
function spendOf(addr, prevTxid, prevVout) {
  return {
    txid: prevTxid,
    vout: prevVout,
    prevout: { scriptpubkey_address: addr },
  };
}
function coinbaseVin() {
  // Real coinbase vins lack `prevout` and have no inbound txid; the fallback
  // must handle this without throwing or polluting the spent set.
  return { is_coinbase: true, sequence: 0xffffffff };
}

// ---- fetch stub ----
// Routes by URL path suffix. Each handler can return either a Response or
// throw. Unmatched URLs throw — keeps tests honest about which endpoints get
// hit.
function withRouter(routes, body) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url);
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
  return Promise.resolve()
    .then(() => body(calls))
    .finally(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      globalThis.fetch = orig;
    });
}
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function textResp(s, status = 200) {
  return new Response(s, { status, headers: { 'Content-Type': 'text/plain' } });
}

// ---- tests ----

await test('Esplora 400 with >500 message routes to fallback and returns received-minus-spent', async () => {
  const addr = testAddr(1);
  // Scenario: address received 3 outputs across 2 confirmed txs, then spent
  // one in a third confirmed tx. Expected unspent count: 2.
  const rxA = chainTx({ id: txid(1), vouts: [payTo(addr, 10000), payTo(OTHER, 999)], height: 800001 });
  const rxB = chainTx({ id: txid(2), vouts: [payTo(OTHER, 500), payTo(addr, 20000)], height: 800002 });
  const spendA0 = chainTx({
    id: txid(3),
    vins: [spendOf(addr, txid(1), 0)],
    vouts: [payTo(addr, 9500)],
    height: 800003,
  });
  // Newest-first ordering: spendA0 (h=800003) → rxB (800002) → rxA (800001).
  const page = [spendA0, rxB, rxA];
  return withRouter(
    [
      [`/address/${addr}/utxo`, () => textResp('Too many unspent transaction outputs (>500). Contact support to raise limits.', 400)],
      [`/address/${addr}/txs/mempool`, () => jsonResp([])],
      [`/address/${addr}/txs/chain`, () => jsonResp(page)],
    ],
    async () => {
      const out = await getUtxos(addr);
      if (!Array.isArray(out)) return false;
      // Expected unspent: txid(2):1 (from rxB) and txid(3):0 (the change from spendA0).
      // txid(1):0 was spent by spendA0; OTHER's outputs never count.
      const keys = out.map(u => `${u.txid}:${u.vout}`).sort();
      const expected = [`${txid(2)}:1`, `${txid(3)}:0`].sort();
      if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        console.log('    got', keys, 'expected', expected);
        return false;
      }
      // Field shape parity with Esplora's /utxo: txid/vout/value/status.
      for (const u of out) {
        if (typeof u.txid !== 'string') return false;
        if (typeof u.vout !== 'number') return false;
        if (typeof u.value !== 'number') return false;
        if (!u.status || u.status.confirmed !== true) return false;
        if (typeof u.status.block_height !== 'number') return false;
      }
      return true;
    },
  );
});

await test('non-cap 400 errors propagate (e.g. malformed address)', async () => {
  const addr = testAddr(2);
  return withRouter(
    [
      [`/address/${addr}/utxo`, () => textResp('Invalid Bitcoin address', 400)],
    ],
    async () => {
      try {
        await getUtxos(addr);
        return false; // should have thrown
      } catch (e) {
        return /API 400.*Invalid Bitcoin address/.test(String(e.message));
      }
    },
  );
});

await test('happy path passes through Esplora /utxo unchanged (no fallback)', async () => {
  const addr = testAddr(3);
  const native = [{ txid: txid(7), vout: 0, value: 1234, status: { confirmed: true, block_height: 800010 } }];
  return withRouter(
    [
      [`/address/${addr}/utxo`, () => jsonResp(native)],
      // Mempool / chain routes intentionally absent — would throw if hit.
    ],
    async (calls) => {
      const out = await getUtxos(addr);
      if (calls.length !== 1) return false;
      return JSON.stringify(out) === JSON.stringify(native);
    },
  );
});

await test('paginates /txs/chain via last_seen_txid and terminates on short page', async () => {
  const addr = testAddr(4);
  // 25 txs (full page) → second page (5 txs) → loop exits.
  const fullPage = [];
  for (let i = 0; i < 25; i++) {
    fullPage.push(chainTx({ id: txid(100 + i), vouts: [payTo(addr, 1000 + i)], height: 800100 - i }));
  }
  const tailPage = [];
  for (let i = 0; i < 5; i++) {
    tailPage.push(chainTx({ id: txid(200 + i), vouts: [payTo(addr, 2000 + i)], height: 800070 - i }));
  }
  const expectedLastSeen = fullPage[fullPage.length - 1].txid;
  let chainCalls = 0;
  let secondPageUrl = '';
  return withRouter(
    [
      [`/address/${addr}/utxo`, () => textResp('Too many unspent transaction outputs (>500)', 400)],
      [`/address/${addr}/txs/mempool`, () => jsonResp([])],
      [`/address/${addr}/txs/chain`, (url) => {
        chainCalls += 1;
        if (chainCalls === 1) return jsonResp(fullPage);
        secondPageUrl = url;
        return jsonResp(tailPage);
      }],
    ],
    async () => {
      const out = await getUtxos(addr);
      if (chainCalls !== 2) { console.log('    chain calls', chainCalls); return false; }
      if (!secondPageUrl.endsWith(`/address/${addr}/txs/chain/${expectedLastSeen}`)) {
        console.log('    second page url', secondPageUrl);
        return false;
      }
      if (out.length !== 30) { console.log('    out len', out.length); return false; }
      return true;
    },
  );
});

await test('mempool tx contributes an unconfirmed UTXO with status.confirmed=false', async () => {
  const addr = testAddr(5);
  const memTxid = txid(50);
  return withRouter(
    [
      [`/address/${addr}/utxo`, () => textResp('Too many unspent transaction outputs (>500)', 400)],
      [`/address/${addr}/txs/mempool`, () => jsonResp([
        mempoolTx({ id: memTxid, vouts: [payTo(addr, 7777)] }),
      ])],
      [`/address/${addr}/txs/chain`, () => jsonResp([])],
    ],
    async () => {
      const out = await getUtxos(addr);
      if (out.length !== 1) return false;
      const u = out[0];
      return u.txid === memTxid && u.vout === 0 && u.value === 7777 && u.status.confirmed === false;
    },
  );
});

await test('outputs paying other addresses are not returned', async () => {
  const addr = testAddr(6);
  return withRouter(
    [
      [`/address/${addr}/utxo`, () => textResp('Too many unspent transaction outputs (>500)', 400)],
      [`/address/${addr}/txs/mempool`, () => jsonResp([])],
      [`/address/${addr}/txs/chain`, () => jsonResp([
        chainTx({ id: txid(60), vouts: [payTo(OTHER, 1), payTo(OTHER, 2), payTo(OTHER, 3)] }),
      ])],
    ],
    async () => {
      const out = await getUtxos(addr);
      return out.length === 0;
    },
  );
});

await test('coinbase vin (no prevout) does not pollute the spent set', async () => {
  const addr = testAddr(7);
  const coinbase = chainTx({
    id: txid(70),
    vins: [coinbaseVin()],
    vouts: [payTo(addr, 5_000_000_000)],
  });
  return withRouter(
    [
      [`/address/${addr}/utxo`, () => textResp('Too many unspent transaction outputs (>500)', 400)],
      [`/address/${addr}/txs/mempool`, () => jsonResp([])],
      [`/address/${addr}/txs/chain`, () => jsonResp([coinbase])],
    ],
    async () => {
      const out = await getUtxos(addr);
      if (out.length !== 1) return false;
      return out[0].txid === txid(70) && out[0].value === 5_000_000_000;
    },
  );
});

await test('mempool endpoint failure is non-fatal: chain-only result returns', async () => {
  const addr = testAddr(8);
  return withRouter(
    [
      [`/address/${addr}/utxo`, () => textResp('Too many unspent transaction outputs (>500)', 400)],
      [`/address/${addr}/txs/mempool`, () => textResp('upstream timeout', 503)],
      [`/address/${addr}/txs/chain`, () => jsonResp([
        chainTx({ id: txid(80), vouts: [payTo(addr, 4242)] }),
      ])],
    ],
    async () => {
      const out = await getUtxos(addr);
      return out.length === 1 && out[0].value === 4242 && out[0].status.confirmed === true;
    },
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
